import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// Generate JWT Token
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
export const login = async (req, res) => {
    try {
        const { whatsapp, password } = req.body;

        if (!whatsapp || !password) {
            console.log('Missing credentials');
            return res.status(400).json({ error: 'Please provide WhatsApp number and password' });
        }
        // Find user by whatsapp and include password, populate role and department
const user = await User.findOne({ whatsapp })
    .select('+password')
    .populate('role')
    .populate('department', 'name');

        if (!user) {
            console.log('User not found for whatsapp:', whatsapp);
            return res.status(401).json({ error: 'User not found' });
        }

        console.log('User found, checking password');
        // Check password
        const isMatch = await user.matchPassword(password);

        if (!isMatch) {
            console.log('Password mismatch');
            return res.status(401).json({ error: 'Incorrect password' });
        }

        console.log('Password matched, generating token');
        // Generate token
        const token = generateToken(user._id);

        res.json({
            success: true,
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                whatsapp: user.whatsapp,
                role: user.role,
                permissions: user.role?.permissions || {},
                department: user.department,
            },
        });
    } catch (error) {
        console.error('Login error:', error);
        console.error('Error stack:', error.stack);
        console.error('Error message:', error.message);
        res.status(500).json({ error: 'Server error', details: process.env.NODE_ENV === 'development' ? error.message : undefined });
    }
};

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
export const getCurrentUser = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).populate('role').populate('department', 'name');

        res.json({
            success: true,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                whatsapp: user.whatsapp,
                role: user.role,
                permissions: user.role?.permissions || {},
                department: user.department,
            },
        });
    } catch (error) {
        console.error('Get current user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// @desc    Register new user (for testing/admin purposes)
// @route   POST /api/auth/register
// @access  Public (should be protected in production)
export const register = async (req, res) => {
    try {
        const { name, email, whatsapp, password, role, department, designation } = req.body;

        // Check if WhatsApp already exists (email can be duplicated)
        const userExists = await User.findOne({ whatsapp });

        if (userExists) {
            return res.status(400).json({ error: 'User with this WhatsApp number already exists' });
        }

        // If request has a user (authenticated), validate role hierarchy using managedRoles
        if (req.user && role) {
            const Role = (await import('../models/Role.js')).default;
            const assignedRole = await Role.findById(role);
            const currentUserRole = await Role.findById(req.user.role._id || req.user.role).populate('managedRoles');

            if (assignedRole && currentUserRole) {
                // Check if the assigned role is in the current user's managedRoles
                const canAssignRole = currentUserRole.managedRoles.some(
                    managedRole => managedRole._id.toString() === assignedRole._id.toString()
                );

                if (!canAssignRole) {
                    const allowedRoleNames = currentUserRole.managedRoles.map(r => r.displayName).join(', ');
                    return res.status(403).json({
                        error: `You cannot assign the "${assignedRole.displayName}" role. You can only assign: ${allowedRoleNames || 'No roles'}`
                    });
                }
            }
        }

        // Create user
        const user = await User.create({
            name,
            email,
            whatsapp,
            password,
            role: role || 'Staff',
            department: department && department !== '' ? department : null,
            designation: designation || '',
        });

        // Generate token
        const token = generateToken(user._id);

        res.status(201).json({
            success: true,
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                whatsapp: user.whatsapp,
                role: user.role,
                department: user.department,
                designation: user.designation,
            },
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
};
