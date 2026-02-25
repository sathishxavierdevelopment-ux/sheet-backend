import Task from '../models/Task.js';
import User from '../models/User.js';
import { notifyTaskAssigned, notifyStatusChanged, notifyTaskComment } from '../services/notificationService.js';
import { emitToUser, broadcast } from '../socket.js';

// Role hierarchy for permissions
const ROLE_HIERARCHY = {
    Director: 4,
    GeneralManager: 3,
    Manager: 2,
    Staff: 1,
};

// @desc    Create new task
// @route   POST /api/tasks
// @access  Private
// @desc    Create new task
// @route   POST /api/tasks
// @access  Private
export const createTask = async (req, res) => {
    try {
        const { task, assignedToEmail, assignedToUserId, priority, durationType, durationValue, notes, isSelfTask, taskGivenBy, taskGivenByName: providedTaskGivenByName } = req.body;
        const currentUser = req.user;

        if (!task) {
            return res.status(400).json({ error: 'Task description is required' });
        }

        let assignedUser;

        if (isSelfTask) {
            assignedUser = await User.findById(currentUser._id).populate('role department');
        } else if (assignedToUserId) {
            assignedUser = await User.findById(assignedToUserId).populate('role department');
        } else {
            // Fallback for legacy requests or if only email provided
            let targetEmail = assignedToEmail;

            if (!targetEmail) {
                return res.status(400).json({ error: 'Please select a user to assign the task to' });
            }
            assignedUser = await User.findOne({ email: targetEmail }).populate('role department');
        }

        if (!assignedUser) {
            return res.status(404).json({ error: `Assigned user not found` });
        }

        // Get Role details for permissions/notifications logic
        const Role = (await import('../models/Role.js')).default;

        // Current User Role
        const currentUserRoleDoc = await Role.findById(currentUser.role._id || currentUser.role);
        const currentRoleName = currentUserRoleDoc?.name?.toLowerCase().replace(/\s+/g, '') || 'staff';

        // Assigned User Role
        const assignedUserRoleDoc = await Role.findById(assignedUser.role._id || assignedUser.role);
        const assignedRoleName = assignedUserRoleDoc?.name?.toLowerCase().replace(/\s+/g, '') || 'staff';

        // Determine simplified level for legacy logic
        let assignedRoleLevel = 1; // Default to Staff
        if (assignedRoleName.includes('director')) assignedRoleLevel = 4;
        else if (assignedRoleName.includes('generalmanager')) assignedRoleLevel = 3;
        else if (assignedRoleName.includes('manager') || assignedRoleName.includes('head')) assignedRoleLevel = 2;

        // Find task giver if provided
        let taskGivenByName = providedTaskGivenByName || '';
        if (req.body.taskGivenByUserId) {
            const giverUser = await User.findById(req.body.taskGivenByUserId);
            if (giverUser) {
                taskGivenByName = giverUser.name;
                // Update the email stored to match the found user, to keep data consistent
                // taskGivenBy variable is essentially the email string in the schema
                // so we might want to ensure we store the correct email if we found the user by ID
                if (giverUser.email) {
                    req.body.taskGivenBy = giverUser.email;
                }
            }
        } else if (taskGivenBy && !taskGivenByName) {
            // Fallback to email lookup
            const giverUser = await User.findOne({ email: taskGivenBy });
            if (giverUser) {
                taskGivenByName = giverUser.name;
            }
        }

        // Calculate due date
        const now = new Date();
        let dueDate;
        if (durationType === 'hours') {
            dueDate = new Date(now.getTime() + durationValue * 60 * 60 * 1000);
        } else {
            dueDate = new Date(now.getTime() + durationValue * 24 * 60 * 60 * 1000);
        }

        // Create task
        const newTask = await Task.create({
            task,
            createdBy: req.user._id,
            createdByEmail: req.user.email,
            assignedTo: assignedUser._id,
            assignedToName: assignedUser.name,
            assignedToEmail: assignedUser.email,
            priority: priority || 'Medium',
            dueDate,
            notes: notes || '',
            isSelfTask: isSelfTask || false,
            taskGivenBy: taskGivenBy || '',
            taskGivenByName: taskGivenByName,
        });

        // --- Notification Logic ---

        try {
            // Standard notification to assignee
            notifyTaskAssigned(newTask, assignedUser, req.user);

            // Special Notification Rules

            // Rule 1: Main Director assigns to Executive-level (Staff/Level 1), notify Assignee's Dept Head
            const isMainDirector = currentRoleName === 'maindirector';
            const isExecutive = assignedRoleLevel === 1 || assignedRoleName === 'staff';

            if (isMainDirector && isExecutive && assignedUser.department) {
                const RoleModel = (await import('../models/Role.js')).default;
                const managerRoles = await RoleModel.find({ name: { $in: ['manager', 'departmenthead', 'generalmanager'] } });
                const managerRoleIds = managerRoles.map(r => r._id);

                const assigneeDeptHead = await User.findOne({
                    department: assignedUser.department,
                    role: { $in: managerRoleIds }
                });

                if (assigneeDeptHead) {
                    notifyTaskAssigned(newTask, assigneeDeptHead, req.user);
                }
            }

            // Rule 2: Staff assigns to another department, notify OWN Dept Head
            if (currentRoleName === 'staff' && !isSelfTask) {
                const assignedToDifferentDept = !currentUser.department || !assignedUser.department || currentUser.department.toString() !== assignedUser.department.toString();

                if (assignedToDifferentDept && currentUser.department) {
                    // Find User's Own Dept Head
                    const RoleModel = (await import('../models/Role.js')).default;
                    const managerRoles = await RoleModel.find({ name: { $in: ['manager', 'departmenthead'] } });
                    const managerRoleIds = managerRoles.map(r => r._id);

                    const myDeptHead = await User.findOne({
                        department: currentUser.department,
                        role: { $in: managerRoleIds }
                    });

                    if (myDeptHead) {
                        notifyTaskAssigned(newTask, myDeptHead, req.user);
                    }
                }
            }

        } catch (notifError) {
            console.error('Notification logic error:', notifError);
        }

        // --- Emit Socket Event ---
        const targetUserId = newTask.assignedTo?._id || newTask.assignedTo;
        emitToUser(String(targetUserId), 'task_created', newTask);

        res.status(201).json({
            success: true,
            task: newTask,
        });
    } catch (error) {
        console.error('Create task error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
};

// @desc    Get tasks assigned to current user (by others)
// @route   GET /api/tasks
// @access  Private
export const getTasks = async (req, res) => {
    try {
        const userEmail = req.user.email;

        // All users see only tasks assigned TO them BY others (excludes self-tasks)
        const tasks = await Task.find({
            assignedToEmail: userEmail,
            createdByEmail: { $ne: userEmail }, // Not created by themselves
        })
            .populate({
                path: 'createdBy',
                select: 'name email role designation',
                populate: { path: 'role', select: 'displayName' }
            })
            .populate({
                path: 'assignedTo',
                select: 'name email role designation',
                populate: { path: 'role', select: 'displayName' }
            })
            .populate('forwardedBy', 'name email')
            .populate('comments.createdBy', 'name role designation')
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            tasks,
        });
    } catch (error) {
        console.error('Get tasks error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// @desc    Get self tasks
// @route   GET /api/tasks/self
// @access  Private
export const getSelfTasks = async (req, res) => {
    try {
        const tasks = await Task.find({
            createdByEmail: req.user.email,
            assignedToEmail: req.user.email,
            isSelfTask: true,
        })
            .populate({
                path: 'createdBy',
                select: 'name email role designation',
                populate: { path: 'role', select: 'displayName' }
            })
            .populate({
                path: 'assignedTo',
                select: 'name email role designation',
                populate: { path: 'role', select: 'displayName' }
            })
            .populate('comments.createdBy', 'name role designation')
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            tasks,
        });
    } catch (error) {
        console.error('Get self tasks error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// @desc    Get tasks assigned by current user (to others)
// @route   GET /api/tasks/assigned
// @access  Private
export const getAssignedTasks = async (req, res) => {
    try {
        // Tasks created BY me and assigned TO others (excludes self-tasks)
        const tasks = await Task.find({
            createdByEmail: req.user.email,
            assignedToEmail: { $ne: req.user.email }, // Not assigned to themselves
        })
            .populate({
                path: 'createdBy',
                select: 'name email role designation department whatsapp',
                populate: { path: 'role', select: 'displayName' }
            })
            .populate({
                path: 'assignedTo',
                select: 'name email role designation department whatsapp',
                populate: [
                    { path: 'role', select: 'displayName' },
                    { path: 'department', select: 'name' }
                ]
            })
            .populate({
                path: 'approvedBy',
                select: 'name email'
            })
            .populate('forwardedBy', 'name email')
            .populate('comments.createdBy', 'name role designation')
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            tasks,
        });
    } catch (error) {
        console.error('Get assigned tasks error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// @desc    Get all tasks (role-based filtering)
// @route   GET /api/tasks/all
// @access  Private
// @desc    Get all tasks (role-based filtering)
// @route   GET /api/tasks/all
// @access  Private
// @desc    Get all tasks (role-based filtering)
// @route   GET /api/tasks/all
// @access  Private
import mongoose from 'mongoose'; // Added mongoose import for ObjectId.isValid
export const getAllTasks = async (req, res) => {
    try {
        const currentUser = req.user;
        const Role = (await import('../models/Role.js')).default;

        // Handle case where role might be a string (legacy/default) or an ObjectId
        let currentUserRole = null;
        if (currentUser.role && typeof currentUser.role === 'object' && currentUser.role._id) {
            currentUserRole = await Role.findById(currentUser.role._id);
        } else if (currentUser.role && mongoose.Types.ObjectId.isValid(currentUser.role)) {
            currentUserRole = await Role.findById(currentUser.role);
        }

        const currentRoleName = currentUserRole?.name?.toLowerCase().replace(/\s+/g, '') || 'staff';
        let tasks;

        // 1. Super Admin, Main Director, Director, General Manager - View ALL Tasks
        // Explicitly exclude Staff from this block even if permissions are wonky
        if (['superadmin', 'maindirector', 'director', 'generalmanager'].includes(currentRoleName) ||
            (currentUserRole?.permissions?.viewAllTasks && currentRoleName !== 'staff')) {

            tasks = await Task.find()
                .populate({
                    path: 'createdBy',
                    select: 'name email role designation department whatsapp',
                    populate: [
                        { path: 'role', select: 'displayName' },
                        { path: 'department', select: 'name' }
                    ]
                })
                .populate({
                    path: 'assignedTo',
                    select: 'name email role designation department whatsapp',
                    populate: [
                        { path: 'role', select: 'displayName' },
                        { path: 'department', select: 'name' }
                    ]
                })
                .populate({
                    path: 'approvedBy',
                    select: 'name email'
                })
                .populate('forwardedBy', 'name email')
                .populate('comments.createdBy', 'name role designation')
                .sort({ createdAt: -1 });

        }
        // 2. Department Heads - View tasks assigned to staff within their department
        // Explicitly exclude Staff from this block
        else if (['manager', 'departmenthead'].includes(currentRoleName) && currentRoleName !== 'staff') {
            if (!currentUser.department) {
                tasks = [];
            } else {
                // Find all users in the same department
                const departmentUsers = await User.find({ department: currentUser.department }).select('email');
                const departmentEmails = departmentUsers.map(u => u.email);

                // Tasks where ASSIGNEE is in department OR CREATOR is in department OR FORWARDED BY me
                tasks = await Task.find({
                    $or: [
                        { assignedToEmail: { $in: departmentEmails } },
                        { createdByEmail: currentUser.email },
                        { forwardedByEmail: currentUser.email } // Include tasks forwarded by this Dep Head
                    ]
                })
                    .populate({
                        path: 'createdBy',
                        select: 'name email role designation department',
                        populate: [
                            { path: 'role', select: 'displayName' },
                            { path: 'department', select: 'name' }
                        ]
                    })
                    .populate({
                        path: 'assignedTo',
                        select: 'name email role designation department',
                        populate: [
                            { path: 'role', select: 'displayName' },
                            { path: 'department', select: 'name' }
                        ]
                    })
                    .populate('approvedBy', 'name email role')
                    .populate('forwardedBy', 'name email')
                    .populate('comments.createdBy', 'name role designation')
                    .sort({ createdAt: -1 });
            }
        }
        // 3. Project Managers, Standalone Roles, Staff - View OWN Tasks only
        else {
            tasks = await Task.find({
                $or: [
                    { assignedTo: currentUser._id },
                    { createdBy: currentUser._id }
                ]
            })
                .populate({
                    path: 'createdBy',
                    select: 'name email role designation department',
                    populate: [
                        { path: 'role', select: 'displayName' },
                        { path: 'department', select: 'name' }
                    ]
                })
                .populate({
                    path: 'assignedTo',
                    select: 'name email role designation department',
                    populate: [
                        { path: 'role', select: 'displayName' },
                        { path: 'department', select: 'name' }
                    ]
                })
                .populate('approvedBy', 'name email role')
                .populate('forwardedBy', 'name email')
                .populate('comments.createdBy', 'name role designation')
                .sort({ createdAt: -1 });
        }

        res.json({
            success: true,
            tasks,
        });
    } catch (error) {
        console.error('Get all tasks error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// @desc    Get task by ID
// @route   GET /api/tasks/:id
// @access  Private
export const getTaskById = async (req, res) => {
    try {
        const task = await Task.findById(req.params.id)
            .populate({
                path: 'createdBy',
                select: 'name email role designation',
                populate: { path: 'role', select: 'displayName' }
            })
            .populate({
                path: 'assignedTo',
                select: 'name email role designation',
                populate: { path: 'role', select: 'displayName' }
            })
            .populate('approvedBy', 'name email role')
            .populate('comments.createdBy', 'name role designation');

        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        res.json({
            success: true,
            task,
        });
    } catch (error) {
        console.error('Get task by ID error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// @desc    Update task status
// @route   PATCH /api/tasks/:id/status
// @access  Private
export const updateTaskStatus = async (req, res) => {
    try {
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }

        const task = await Task.findById(req.params.id);

        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const userEmail = req.user.email;

        // Only the assigned user can change the task status
        if (task.assignedToEmail !== userEmail) {
            return res.status(403).json({ error: 'Only the assigned user can update task status' });
        }

        // Validate allowed status values
        const allowedStatuses = ['Pending', 'In Progress', 'Waiting for Approval', 'Completed'];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status value' });
        }

        // Prevent users from directly setting status to 'Completed'
        // Completed can only be set via approval process
        if (status === 'Completed') {
            return res.status(403).json({
                error: 'Tasks must be approved by the task creator to be marked as Completed. Please set status to "Waiting for Approval" instead.'
            });
        }

        // Update status
        task.status = status;

        // Handle Approval Workflow
        if (status === 'Waiting for Approval') {
            // When marked as waiting for approval, set approval status to Pending
            task.approvalStatus = 'Pending';
            task.approvedBy = undefined;
            task.approvedAt = undefined;

            // Set Initial Approver
            if (task.isForwarded && task.forwardedBy) {
                task.currentApprover = task.forwardedBy;
                task.forwarderApproved = false; // Reset forwarder approval status
            } else {
                task.currentApprover = task.createdBy;
            }

        } else if (status === 'In Progress' || status === 'Pending') {
            // If moved back to In Progress or Pending, set approval status to Pending
            task.approvalStatus = 'Pending';
            task.approvedBy = undefined;
            task.approvedAt = undefined;
            task.currentApprover = undefined; // Clear approver
            task.forwarderApproved = false;
        }

        await task.save();

        // Send notification when status changes to In Progress or Waiting for Approval.
        // Use req.user as the updating user to ensure the correct name is shown in notifications.
        if (status === 'In Progress' || status === 'Waiting for Approval') {
            const updatingUser = req.user;

            // 1. Always notify the original creator (A)
            const createdByUser = await User.findOne({ email: task.createdByEmail });
            if (createdByUser) {
                notifyStatusChanged(task, updatingUser, createdByUser, status).catch(err => {
                    console.error('Notification error (creator):', err);
                });
            }

            // 2. Also notify the forwarder (B) if the task was forwarded
            if (task.isForwarded && task.forwardedBy) {
                const forwarderUser = await User.findById(task.forwardedBy);
                // Don't notify again if forwarder is the same as creator
                if (forwarderUser && forwarderUser.email !== task.createdByEmail) {
                    notifyStatusChanged(task, updatingUser, forwarderUser, status).catch(err => {
                        console.error('Notification error (forwarder):', err);
                    });
                }
            }
        }

        // --- Emit Socket Events ---
        if (status === 'Waiting for Approval') {
            const approverId = task.currentApprover || task.createdBy;
            emitToUser(String(approverId?._id || approverId), 'task_waiting_approval', task);
        } else {
            // Notify creator about status change
            emitToUser(String(task.createdBy?._id || task.createdBy), 'task_status_changed', task);
        }

        res.json({
            success: true,
            task,
        });
    } catch (error) {
        console.error('Update task status error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// @desc    Update task
// @route   PUT /api/tasks/:id
// @access  Private
export const updateTask = async (req, res) => {
    try {
        const { task: taskDescription, assignedToEmail, assignedToUserId, priority, dueDate, notes } = req.body;

        const task = await Task.findById(req.params.id);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Check if user has permission to update
        const Role = (await import('../models/Role.js')).default;
        const currentUserRole = await Role.findById(req.user.role._id || req.user.role);
        const currentRoleName = currentUserRole?.name?.toLowerCase().replace(/\s+/g, '');
        const userEmail = req.user.email;

        let canUpdate = false;
        // Users with editAllTasks permission (General Manager excluded)
        if (currentUserRole?.permissions?.editAllTasks && currentRoleName !== 'generalmanager') {
            canUpdate = true;
        }
        // Task Creator (if they have editOwnTasks permission)
        else if (task.createdByEmail === userEmail && currentUserRole?.permissions?.editOwnTasks) {
            canUpdate = true;
        }
        // Assignee (Department Head/Manager) can update (primarily for forwarding)
        else if ((task.assignedToEmail === userEmail || task.assignedTo?.toString() === req.user._id.toString()) && ['departmenthead', 'manager'].includes(currentRoleName)) {
            canUpdate = true;
        }

        if (!canUpdate) {
            return res.status(403).json({ error: 'Not authorized to update this task' });
        }

        // Update fields
        if (taskDescription) task.task = taskDescription;
        if (priority) task.priority = priority;
        if (dueDate) task.dueDate = new Date(dueDate);
        if (notes !== undefined) task.notes = notes;

        // If changing assignee (Check by ID if provided, otherwise Email)
        let assignedUser = null;
        if (assignedToUserId) {
            assignedUser = await User.findById(assignedToUserId);
        } else if (assignedToEmail) {
            assignedUser = await User.findOne({ email: assignedToEmail });
        }

        if (assignedUser) {
            // Check if actual change in assignee
            if (assignedUser._id.toString() !== task.assignedTo.toString()) {
                // Check if this is a "Forward" action
                // If the person determining the edit is the current assignee, it is a forward
                const isCurrentAssignee = (task.assignedToEmail === userEmail && userEmail) || (task.assignedTo?.toString() === req.user._id.toString());

                if (isCurrentAssignee) {
                    task.isForwarded = true;
                    task.forwardedBy = req.user._id;
                    task.forwardedByEmail = req.user.email;
                    task.forwardedByName = req.user.name;
                    task.forwardedAt = new Date();

                    // Send notifications for forwarding
                    try {
                        const { sendWhatsAppTemplate } = await import('../services/notificationService.js');
                        const { getWhatsappConfig } = await import('../services/notificationService.js');
                        const config = getWhatsappConfig();

                        // Format due date
                        const formattedDueDate = new Date(task.dueDate).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                        });

                        // Get original creator details
                        const createdByUser = await User.findById(task.createdBy);

                        // 1. Notify new assignee (C) about forwarded task using same new-task template
                        if (config.apiUrl && config.accessToken && assignedUser.whatsapp) {
                            sendWhatsAppTemplate(
                                assignedUser.whatsapp,
                                'fraud_alert_2',
                                [
                                    assignedUser.name,              // {{1}} Assigned User Name (C)
                                    task.sno.toString(),            // {{2}} Task ID
                                    task.task,                      // {{3}} Task Name
                                    req.user.name,                  // {{4}} Assigned By (B the forwarder)
                                    task.priority,                  // {{5}} Priority
                                    formattedDueDate,               // {{6}} Due Date & Time
                                    (task.notes || 'No notes').replace(/[\n\t]/g, ' ')  // {{7}} Notes
                                ],
                                'en_US'
                            ).catch(err => console.error('WhatsApp notification error (new assignee C):', err));
                        }

                        // 2. Notify original creator that task was forwarded
                        if (config.apiUrl && config.accessToken && createdByUser?.whatsapp) {
                            sendWhatsAppTemplate(
                                createdByUser.whatsapp,
                                'fraud_alert_2',
                                [
                                    createdByUser.name,                             // {{1}} Recipient Name
                                    task.sno.toString(),                            // {{2}} Task ID
                                    task.task,                                      // {{3}} Task Name
                                    req.user.name,                                  // {{4}} Forwarded By
                                    task.priority,                                  // {{5}} Priority
                                    formattedDueDate,                               // {{6}} Due Date & Time
                                    (task.notes || 'No notes').replace(/[\n\t]/g, ' ')  // {{7}} Notes
                                ],
                                'en_US'
                            ).catch(err => console.error('WhatsApp notification error (creator):', err));
                        }
                    } catch (notifError) {
                        console.error('Forwarding notification error:', notifError);
                    }
                }

                task.assignedTo = assignedUser._id;
                task.assignedToName = assignedUser.name;
                task.assignedToEmail = assignedUser.email;
            }
        } else if (assignedToEmail || assignedToUserId) {
            // User tried to assign but not found
            return res.status(404).json({ error: 'Assigned user not found' });
        }

        await task.save();

        const updatedTask = await Task.findById(task._id).populate('createdBy assignedTo', 'name email role');

        // --- Emit Socket Events ---
        const assigneeId = updatedTask.assignedTo?._id || updatedTask.assignedTo;
        const creatorId = updatedTask.createdBy?._id || updatedTask.createdBy;

        if (task.isForwarded && task.forwardedBy) {
            // Notify new assignee
            emitToUser(String(assigneeId), 'task_forwarded', updatedTask);
            // Notify creator
            emitToUser(String(creatorId), 'task_list_update', updatedTask);
        } else {
            // General update notification
            emitToUser(String(assigneeId), 'task_list_update', updatedTask);
            emitToUser(String(creatorId), 'task_list_update', updatedTask);
        }

        res.json({
            success: true,
            task: updatedTask,
        });
    } catch (error) {
        console.error('Update task error:', error);
        res.status(500).json({ error: error.message });
    }
};

// @desc    Delete task
// @route   DELETE /api/tasks/:id
// @access  Private
export const deleteTask = async (req, res) => {
    try {
        const task = await Task.findById(req.params.id);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Check if user has permission to delete
        const Role = (await import('../models/Role.js')).default;
        const currentUserRole = await Role.findById(req.user.role._id || req.user.role);
        const currentRoleName = currentUserRole?.name?.toLowerCase().replace(/\s+/g, '');
        const userEmail = req.user.email;

        let canDelete = false;
        // Users with deleteAllTasks permission (General Manager excluded)
        if (currentUserRole?.permissions?.deleteAllTasks && currentRoleName !== 'generalmanager') {
            canDelete = true;
        }
        // Task Creator (if they have deleteOwnTasks permission)
        else if (task.createdByEmail === userEmail && currentUserRole?.permissions?.deleteOwnTasks) {
            canDelete = true;
        }

        if (!canDelete) {
            return res.status(403).json({ error: 'Not authorized to delete this task' });
        }

        const assigneeId = task.assignedTo.toString();
        await task.deleteOne();

        // --- Emit Socket Event ---
        emitToUser(assigneeId, 'task_list_update', { taskId: req.params.id, deleted: true });

        res.json({
            success: true,
            message: 'Task deleted successfully',
        });
    } catch (error) {
        console.error('Delete task error:', error);
        res.status(500).json({ error: error.message });
    }
};

// @desc    Add comment to task
// @route   POST /api/tasks/:id/comments
// @access  Private
export const addTaskComment = async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Comment text is required' });
        }

        const task = await Task.findById(req.params.id);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const userEmail = req.user.email;

        // Check permissions: Creator, Assignee, or Giver can comment
        let canComment = false;
        if (task.createdByEmail === userEmail) {
            canComment = true;
        } else if (task.assignedToEmail === userEmail) {
            canComment = true;
        } else if (task.taskGivenBy === userEmail) {
            canComment = true;
        }

        if (!canComment) {
            // Check for high-level roles
            const Role = (await import('../models/Role.js')).default;
            const currentUserRole = await Role.findById(req.user.role._id || req.user.role);
            const currentRoleName = currentUserRole?.name?.toLowerCase().replace(/\s+/g, '');

            if (['superadmin', 'maindirector', 'director', 'generalmanager'].includes(currentRoleName)) {
                canComment = true;
            }
        }

        if (!canComment) {
            return res.status(403).json({ error: 'Not authorized to comment on this task' });
        }

        // Fetch full user details to get department
        const commentingUser = await User.findById(req.user._id).populate('department role');

        const newComment = {
            text,
            createdBy: commentingUser._id,
            createdByName: commentingUser.name,
            userRole: commentingUser.role?.displayName || commentingUser.role?.name || 'Staff',
            userDesignation: commentingUser.designation || '',
            userDepartment: commentingUser.department?.name || '',
            createdAt: new Date()
        };

        task.comments.push(newComment);
        await task.save();

        // Return the full task with populated fields
        const updatedTask = await Task.findById(task._id)
            .populate({
                path: 'createdBy assignedTo approvedBy',
                select: 'name email role whatsapp',
                populate: { path: 'role', select: 'displayName' }
            })
            .populate('comments.createdBy', 'name role designation');

        // Send Notification
        // Use the updatedTask which has the populated fields
        notifyTaskComment(updatedTask, commentingUser, text).catch(err => {
            console.error('Comment notification error:', err);
        });

        // --- Emit Socket Events ---
        // Notify both parties involved in the task
        const assignedToId = updatedTask.assignedTo?._id || updatedTask.assignedTo;
        const createdById = updatedTask.createdBy?._id || updatedTask.createdBy;

        emitToUser(String(createdById), 'task_list_update', updatedTask);
        emitToUser(String(assignedToId), 'task_list_update', updatedTask);

        res.json({
            success: true,
            task: updatedTask,
        });
    } catch (error) {
        console.error('Add comment error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};
