import User from '../models/User.js';
import OTP from '../models/OTP.js';
import { sendOTPWhatsApp } from '../services/notificationService.js';

// Rate limiting map (in production, use Redis)
const otpAttempts = new Map();

// Helper to check rate limit
const checkRateLimit = (whatsapp) => {
    const now = Date.now();
    const attempts = otpAttempts.get(whatsapp) || [];

    // Remove attempts older than 15 minutes
    const recentAttempts = attempts.filter(time => now - time < 15 * 60 * 1000);

    if (recentAttempts.length >= 3) {
        return false;
    }

    recentAttempts.push(now);
    otpAttempts.set(whatsapp, recentAttempts);
    return true;
};

// @desc    Send OTP to WhatsApp
// @route   POST /api/password-reset/send-otp
// @access  Public
export const sendOTP = async (req, res) => {
    try {
        const { whatsapp } = req.body;

        if (!whatsapp) {
            return res.status(400).json({ error: 'WhatsApp number is required' });
        }

        // Check rate limit
        if (!checkRateLimit(whatsapp)) {
            return res.status(429).json({
                error: 'Too many OTP requests. Please try again after 15 minutes.'
            });
        }

        // Check if user exists
        const user = await User.findOne({ whatsapp });
        if (!user) {
            return res.status(404).json({ error: 'No account found with this WhatsApp number' });
        }


        // Generate 6-digit OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

        console.log("OTP Code:", otpCode);
        // Delete any existing OTPs for this number
        await OTP.deleteMany({ whatsapp });

        // Create new OTP
        const otp = await OTP.create({
            whatsapp,
            otp: otpCode,
        });

        // Send OTP via WhatsApp
        const whatsappResult = await sendOTPWhatsApp(whatsapp, otpCode);

        if (!whatsappResult.success) {
            return res.status(500).json({
                error: 'Failed to send OTP. Please try again.'
            });
        }

        res.json({
            success: true,
            message: 'OTP sent successfully to your WhatsApp',
            expiresIn: 15 * 60, // 15 minutes in seconds
        });
    } catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
    }
};

// @desc    Verify OTP
// @route   POST /api/password-reset/verify-otp
// @access  Public
export const verifyOTP = async (req, res) => {
    try {
        const { whatsapp, otp } = req.body;

        if (!whatsapp || !otp) {
            return res.status(400).json({ error: 'WhatsApp number and OTP are required' });
        }

        // Find OTP record
        const otpRecord = await OTP.findOne({
            whatsapp,
            verified: false,
            expiresAt: { $gt: new Date() }
        });

        if (!otpRecord) {
            return res.status(400).json({ error: 'Invalid or expired OTP' });
        }

        // Verify OTP
        const isValid = otpRecord.compareOTP(otp);
        if (!isValid) {
            return res.status(400).json({ error: 'Invalid OTP' });
        }

        // Mark as verified
        otpRecord.verified = true;
        await otpRecord.save();

        res.json({
            success: true,
            message: 'OTP verified successfully',
            resetToken: otpRecord._id.toString(), // Use OTP ID as reset token
        });
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ error: 'Failed to verify OTP. Please try again.' });
    }
};

// @desc    Reset password
// @route   POST /api/password-reset/reset-password
// @access  Public
export const resetPassword = async (req, res) => {
    try {
        const { whatsapp, resetToken, newPassword } = req.body;

        if (!whatsapp || !resetToken || !newPassword) {
            return res.status(400).json({
                error: 'WhatsApp number, reset token, and new password are required'
            });
        }

        // Validate password length
        if (newPassword.length < 6) {
            return res.status(400).json({
                error: 'Password must be at least 6 characters long'
            });
        }

        // Find verified OTP record
        const otpRecord = await OTP.findOne({
            _id: resetToken,
            whatsapp,
            verified: true,
            expiresAt: { $gt: new Date() }
        });

        if (!otpRecord) {
            return res.status(400).json({
                error: 'Invalid or expired reset token. Please request a new OTP.'
            });
        }

        // Find user and update password
        const user = await User.findOne({ whatsapp });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        user.password = newPassword;
        await user.save();

        // Delete the OTP record
        await OTP.deleteOne({ _id: resetToken });

        res.json({
            success: true,
            message: 'Password reset successfully. You can now login with your new password.',
        });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password. Please try again.' });
    }
};
