import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Name is required'],
            trim: true,
        },
        designation: {
            type: String,
            trim: true,
            default: '',
        },
        email: {
            type: String,
            required: false, // Email is now optional
            lowercase: true,
            trim: true,
        },
        whatsapp: {
            type: String,
            required: [true, 'WhatsApp number is required'],
            unique: true,
            trim: true,
        },
        password: {
            type: String,
            required: [true, 'Password is required'],
            minlength: 6,
            select: false, // Don't return password by default
        },
        role: {
            type: mongoose.Schema.Types.Mixed, // Support both String and ObjectId during migration
            ref: 'Role',
            default: 'Staff',
        },
        department: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Department',
            default: null,
        },
        original_password: {
            type: String,
            select: false, // Don't return by default
        },
    },
    {
        timestamps: true,
    }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) {
        next();
        return;
    }
    // Store plain text password before hashing
    this.original_password = this.password;

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// Method to compare password
userSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model('User', userSchema);

export default User;
