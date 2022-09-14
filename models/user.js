const mongoose = require('mongoose')
const Schema = mongoose.Schema
const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    workspaces: [
        {
            type: Schema.Types.ObjectId,
            ref: 'Workspace'
        }
    ],
    email: {
        type: String,
        required: true,
        match: /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/
    },
    newNotifications: Number,
    assignedTasks: [
        {
            type: Schema.Types.ObjectId,
            ref: 'Task'
        }
    ]
})

module.exports = mongoose.model('User', userSchema)
