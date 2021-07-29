const mongoose = require('mongoose')
const taskSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    options: [
        {
            column: mongoose.Types.ObjectId,
            value: mongoose.Types.ObjectId,
            type: { type: String }
        }
    ]
})

module.exports = mongoose.model('Task', taskSchema)
