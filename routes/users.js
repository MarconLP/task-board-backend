const passport = require('passport')
const User = require('./../models/user')
const RefreshToken = require('./../models/refreshToken')
const router = require('express').Router()
const bcrypt = require('bcrypt')
const { wrapAsync, isLoggedIn } = require('../middleware')
const { verify } = require('jsonwebtoken')
const AppError = require('../HttpError')
const {
    createAccessToken,
    createRefreshToken,
    sendRefreshToken,
    createRefreshTokenDoc
} = require('../utils/auth')
const { authenticator } = require('otplib')
const axios = require('axios')
const jwt = require('jsonwebtoken')
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse
} = require('@simplewebauthn/server')

router.get(
    '/logout',
    wrapAsync(async (req, res) => {
        const sessionId = req.session.id
        const io = req.app.get('socketio')

        // req.session.destroy(() => {
        //     io.to(sessionId).disconnectSockets()
        //     res.status(204).end()
        // })
        //
        // req.logout()

        res.clearCookie('refresh_token')
        res.json({ success: true, message: 'OK' })
    })
)

router.post(
    '/register',
    wrapAsync(async (req, res) => {
        const { username, email, password } = req.body
        const user = await User.findOne({ email })
        if (user) throw new AppError('User already exists', 400)

        const hash = await bcrypt.hashSync(password, 12)

        const newUser = new User({
            username,
            password: hash,
            workspaces: [],
            email
        })

        await newUser.save()

        res.json({
            success: true,
            message: 'user created'
        })
    })
)

router.get(
    '/workspaces',
    isLoggedIn,
    wrapAsync(async (req, res) => {
        const user = await User.findById(req.user._id).populate('workspaces')
        res.json({
            success: true,
            workspaces: user.workspaces
        })
    })
)

router.get(
    '/oauth/google',
    wrapAsync(async (req, res) => {
        const { code } = req.query

        const { data } = await axios({
            url: 'https://oauth2.googleapis.com/token',
            method: 'POST',
            data: {
                code,
                client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
                client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
                redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URL,
                grant_type: 'authorization_code'
            }
        })

        const { email, name, email_verified } = jwt.decode(data.id_token)

        if (!email_verified)
            return res.redirect(
                `${process.env.FRONTEND_HOST}/error?error=Email not verified`
            )

        const user = await User.findOne({ email })

        if (user) {
            const token = await createRefreshToken(user._id)
            const refreshToken = createRefreshTokenDoc(req, token, user)
            user.refreshTokens.push(refreshToken)
            sendRefreshToken(res, token)

            await refreshToken.save()
            await user.save()
        } else {
            const newUser = new User({
                username: name,
                workspaces: [],
                password: null,
                email
            })

            await newUser.save()

            const token = await createRefreshToken(newUser._id)
            const refreshToken = createRefreshTokenDoc(req, token, newUser)
            newUser.refreshTokens.push(refreshToken)
            sendRefreshToken(res, token)

            await refreshToken.save()
            await newUser.save()
        }

        res.redirect(process.env.FRONTEND_HOST)
    })
)

router.post(
    '/login',
    wrapAsync(async (req, res) => {
        const {
            email,
            password,
            totp,
            request_security_key_challenge,
            authenticatorResponse
        } = req.body
        let user = await User.findOne({ email })
            .populate('refreshTokens')
            .populate({
                path: 'workspaces',
                select: ['id', 'name']
            })
            .populate({
                path: 'assignedTasks',
                select: ['name', 'options', 'workspace', 'board'],
                populate: [
                    {
                        path: 'workspace',
                        select: ['_id']
                    },
                    {
                        path: 'board',
                        select: ['space', 'name'],
                        populate: {
                            path: 'space',
                            select: 'name'
                        }
                    }
                ]
            })
        if (!user) throw new AppError('User does not exist', 400)

        if (!password)
            return res.json({
                success: false,
                nextStep: 'password'
            })

        if (!user.password) throw new AppError('Invalid password', 400)
        const valid = await bcrypt.compareSync(password, user.password)
        if (!valid) throw new AppError('Invalid password', 400)

        if (user.multiFactorAuth) {
            const totpMethod = user.multiFactorMethods.find(
                x => x.type === 'totp'
            )
            const securityKeyMethod = user.multiFactorMethods.find(
                x => x.type === 'security_key'
            )
            const emailMethod = user.multiFactorMethods.find(
                x => x.type === 'email'
            )
            if (totp && totpMethod) {
                try {
                    authenticator.options = { window: 2 }
                    const valid = authenticator.check(totp, totpMethod.secret)
                    if (!valid) {
                        if (totpMethod.backup_codes.includes(totp)) {
                            totpMethod.backup_codes =
                                totpMethod.backup_codes.filter(
                                    x => x.toString() !== totp
                                )
                        } else throw Error()
                    }
                } catch (err) {
                    throw new AppError(
                        'Invalid Multi Factor Authentication',
                        400
                    )
                }
            } else if (securityKeyMethod && authenticatorResponse) {
                const expectedChallenge = currentChallenges[user._id].challenge

                const authenticator = securityKeyMethod.devices[0]

                if (!authenticator) {
                    throw new Error(
                        `Could not find authenticator ${authenticatorResponse.id} for user ${user.id}`
                    )
                }

                let verification
                try {
                    verification = await verifyAuthenticationResponse({
                        credential: authenticatorResponse,
                        expectedChallenge,
                        expectedOrigin: 'http://localhost:3000',
                        expectedRPID: 'localhost',
                        authenticator
                    })
                } catch (error) {
                    console.error(error)
                    return res.status(400).send({ error: error.message })
                }

                const { verified } = verification
                if (!verified) throw Error('somethings wrong, you are hacker')
            } else if (securityKeyMethod && request_security_key_challenge) {
                const options = generateAuthenticationOptions({
                    // Require users to use a previously-registered authenticator
                    allowCredentials: securityKeyMethod.devices.map(
                        authenticator => {
                            return {
                                id: authenticator.credentialID,
                                type: 'public-key',
                                // Optional
                                transports: authenticator.transports
                            }
                        }
                    ),
                    userVerification: 'preferred'
                })

                // (Pseudocode) Remember this challenge for this user
                currentChallenges[user._id] = {
                    id: user._id.toString(),
                    challenge: options.challenge
                }

                return res.json({ success: false, options })
            } else {
                return res.status(200).json({
                    success: false,
                    nextStep: 'mfa',
                    methods: ['totp', 'security_key', 'email']
                })
            }
        }

        // remove expired refreshTokens
        const expiredTokens = user.refreshTokens
            .filter(x => x.expiresAt < Date.now())
            .map(x => x._id)
        await RefreshToken.deleteMany({
            _id: { $in: expiredTokens }
        })
        user.refreshTokens = user.refreshTokens.filter(x => {
            return !expiredTokens.includes(x._id)
        })

        const token = await createRefreshToken(user._id)
        const refreshToken = createRefreshTokenDoc(req, token, user)
        user.refreshTokens.push(refreshToken)
        sendRefreshToken(res, token)

        await refreshToken.save()
        await user.save()
        res.json({
            success: true,
            accessToken: createAccessToken(user._id),
            user: {
                username: user.username,
                workspaces: user.workspaces,
                _id: user._id,
                assignedTasks: user.assignedTasks,
                newNotifications: user.newNotifications
            }
        })
    })
)

router.get(
    '/refresh',
    wrapAsync(async (req, res) => {
        const token = req.cookies.refresh_token
        if (!token) throw new AppError('invalid refresh token', 400)

        let payload = null
        try {
            payload = verify(token, process.env.REFRESH_TOKEN_SECRET)
        } catch (err) {
            throw new AppError('invalid refresh token', 400)
        }

        const user = await User.findById(payload.user._id)
            .populate('refreshTokens')
            .populate({
                path: 'workspaces',
                select: ['id', 'name']
            })
            .populate({
                path: 'assignedTasks',
                select: ['name', 'options', 'workspace', 'board'],
                populate: [
                    {
                        path: 'workspace',
                        select: ['_id']
                    },
                    {
                        path: 'board',
                        select: ['space', 'name'],
                        populate: {
                            path: 'space',
                            select: 'name'
                        }
                    }
                ]
            })
        const currentRefreshToken = user.refreshTokens.find(
            x => x.token === token
        )
        if (currentRefreshToken && currentRefreshToken.expiresAt > Date.now()) {
            user.refreshTokens = user.refreshTokens.filter(
                x => x.token !== token
            )
            await RefreshToken.findByIdAndDelete(currentRefreshToken._id)
            const newToken = await createRefreshToken(user._id)
            const newRefreshToken = createRefreshTokenDoc(req, newToken, user)
            await newRefreshToken.save()
            user.refreshTokens.push(newRefreshToken)
            sendRefreshToken(res, newToken)
            await user.save()
        } else {
            res.clearCookie('refresh_token')
            throw new AppError('invalid refresh token', 400)
        }

        res.json({
            success: true,
            accessToken: createAccessToken(user._id),
            username: user.username,
            workspaces: user.workspaces,
            _id: user._id,
            assignedTasks: user.assignedTasks,
            newNotifications: user.newNotifications
        })
    })
)

router.get(
    '/',
    isLoggedIn,
    wrapAsync(async (req, res) => {
        const user = await User.findById(req.user._id)
            .populate({
                path: 'workspaces',
                select: ['id', 'name']
            })
            .populate({
                path: 'assignedTasks',
                select: ['name', 'options', 'workspace', 'board'],
                populate: [
                    {
                        path: 'workspace',
                        select: ['_id']
                    },
                    {
                        path: 'board',
                        select: ['space', 'name'],
                        populate: {
                            path: 'space',
                            select: 'name'
                        }
                    }
                ]
            })
        res.json({
            username: user.username,
            workspaces: user.workspaces,
            _id: user._id,
            assignedTasks: user.assignedTasks,
            newNotifications: user.newNotifications,
            email: user.email
        })
    })
)

let currentChallenges = []

router.get(
    '/generateRegistrationOptions',
    wrapAsync(async (req, res) => {
        // (Pseudocode) Retrieve the user from the database
        // after they've logged in
        const user = await User.findById('6348a3742cf25446c45fed8a')
        // (Pseudocode) Retrieve any of the user's previously-
        // registered authenticators
        const userAuthenticators = user.multiFactorMethods.find(
            x => x.type === 'security_key'
        ).devices

        const options = generateRegistrationOptions({
            rpName: 'TaskBoard',
            rpID: 'localhost',
            userID: user._id,
            userName: user.username,
            // Don't prompt users for additional information about the authenticator
            // (Recommended for smoother UX)
            attestationType: 'direct',
            // Prevent users from re-registering existing authenticators
            excludeCredentials: userAuthenticators.map(authenticator => ({
                id: authenticator.credentialID,
                type: 'public-key',
                // Optional
                transports: authenticator.transports
            }))
        })

        // (Pseudocode) Remember the challenge for this user
        currentChallenges.push({
            id: user._id.toString(),
            challenge: options.challenge
        })

        res.json(options)
    })
)

router.post(
    '/verifyRegistration',
    wrapAsync(async (req, res) => {
        const { body } = req

        // (Pseudocode) Retrieve the logged-in user
        const user = await User.findById('6348a3742cf25446c45fed8a')
        // (Pseudocode) Get `options.challenge` that was saved above

        const expectedChallenge = currentChallenges.find(
            x => x.id === user._id.toString()
        ).challenge

        currentChallenges = currentChallenges.filter(
            x => x.id !== user._id.toString()
        )

        let verification
        try {
            verification = await verifyRegistrationResponse({
                credential: body,
                expectedChallenge,
                expectedOrigin: 'http://localhost:3000',
                expectedRPID: 'localhost'
            })
        } catch (error) {
            console.error(error)
            return res.status(400).send({ error: error.message })
        }

        const { verified } = verification

        const { registrationInfo } = verification
        const { credentialPublicKey, credentialID, counter } = registrationInfo

        user.multiFactorMethods
            .find(x => x.type === 'security_key')
            .devices.push({
                credentialPublicKey: credentialPublicKey,
                credentialID: credentialID,
                counter
            })
        await user.save()

        res.json({ credentialPublicKey, credentialID, counter })
    })
)

router.patch(
    '/profile',
    isLoggedIn,
    wrapAsync(async (req, res) => {
        // res.json({ success: true, message: 'OK' })
        res.json({ success: false, message: 'sudo mode required' })
    })
)

router.delete(
    '/session/:sessionId',
    isLoggedIn,
    wrapAsync(async (req, res) => {
        console.log(req.user)
        res.json({ success: true, message: 'OK' })
        // res.json({ success: false, message: 'sudo mode required' })
    })
)

router.post(
    '/mfa/totp/setup',
    isLoggedIn,
    wrapAsync(async (req, res) => {
        console.log(req.user)
        res.json({ success: true, message: 'OK' })
        // res.json({ success: false, message: 'sudo mode required' })
    })
)

module.exports = router
