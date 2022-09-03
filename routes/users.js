const passport = require('passport')
const Users = require('./../models/user')
const router = require('express').Router()
const bcrypt = require('bcrypt')
const { wrapAsync, isLoggedIn } = require('../middleware')

router.post(
    '/login',
    wrapAsync(async (req, res, next) => {
        passport.authenticate('local', (err, user, info) => {
            if (err) throw err
            if (!user) res.status(403).send('Forbidden')
            else {
                req.logIn(user, err => {
                    if (err) throw err
                    res.json({ success: true, user: req.user })
                })
            }
        })(req, res, next)
    })
)

router.post(
    '/register',
    wrapAsync(async (req, res, next) => {
        Users.findOne({ username: req.body.username }, async (err, doc) => {
            if (err) throw err
            if (doc) res.status(409).send('User Already Exists')
            if (!doc) {
                bcrypt.hash(req.body.password, 12, async function (err, hash) {
                    const newUser = new Users({
                        username: req.body.username,
                        password: hash,
                        workspaces: [],
                        email: req.body.email
                    })
                    await newUser
                        .save()
                        .then(x => {
                            // login user after register
                            passport.authenticate(
                                'local',
                                (err, user, info) => {
                                    if (err) throw err
                                    if (!user)
                                        res.json({
                                            success: false,
                                            error: [
                                                'Username or password is wrong.'
                                            ]
                                        })
                                    else {
                                        req.logIn(user, err => {
                                            if (err) throw err
                                            res.json({
                                                success: true,
                                                user: req.user
                                            })
                                        })
                                    }
                                }
                            )(req, res, next)
                        })
                        .catch(err => {
                            console.log(err)
                            return res.json({
                                success: false,
                                error: ['Email wrong']
                            })
                        })
                })
            }
        })
    })
)

router.get(
    '/logout',
    wrapAsync(async (req, res) => {
        req.logout()
        res.status(200).send('OK')
    })
)

router.get(
    '/',
    wrapAsync(async (req, res) => {
        if (!req.user) return res.status(401).send('Unauthorized')
        res.json({ user: req.user })
    })
)

// clear notification
router.delete(
    '/notification/:workspaceId/:taskId',
    isLoggedIn,
    wrapAsync(async (req, res) => {
        const { workspaceId, taskId } = req.params
        const user = await Users.findById(req.user._id)

        const notifications = user.notifications.find(
            notification => notification.workspaceId.toString() === workspaceId
        )
        const [notification] = notifications.new.splice(
            notifications.new.indexOf(
                notification => notification.taskId === taskId
            ),
            1
        )
        if (notification) notifications.cleared.unshift(notification)

        // await user.save();
        res.send('OK')
    })
)

// unclear notification
router.patch(
    '/notification/:workspaceId/:taskId',
    isLoggedIn,
    wrapAsync(async (req, res) => {
        const { workspaceId, taskId } = req.params
        const user = await Users.findById(req.user._id)

        const notifications = user.notifications.find(
            notification => notification.workspaceId.toString() === workspaceId
        )
        const [notification] = notifications.cleared.splice(
            notifications.cleared.indexOf(
                notification => notification.taskId === taskId
            ),
            1
        )
        if (notification) notifications.new.unshift(notification)

        await user.save()
        res.send('OK')
    })
)

module.exports = router
