import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Email transporter configuration
const createEmailTransporter = () => {
    return nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE || 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
        },
    });
};

// Helper to get WhatsApp config (lazily evaluated to ensure env vars are loaded)
export const getWhatsappConfig = () => {
    return {
        apiUrl: process.env.WHATSAPP_API_URL || (process.env.WHATSAPP_PHONE_NUMBER_ID ? `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages` : undefined),
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    };
};

// Load email template
const loadEmailTemplate = (templateName) => {
    const templatePath = path.join(__dirname, '../templates/email', `${templateName}.html`);
    return fs.readFileSync(templatePath, 'utf-8');
};

// Replace placeholders in template
const renderTemplate = (template, data) => {
    let rendered = template;
    Object.keys(data).forEach(key => {
        const regex = new RegExp(`{{${key}}}`, 'g');
        rendered = rendered.replace(regex, data[key] || '');
    });
    return rendered;
};

// Send Email
export const sendEmail = async (to, subject, templateName, data) => {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
            console.log('Email not configured, skipping email notification');
            return { success: false, message: 'Email not configured' };
        }

        const transporter = createEmailTransporter();
        const template = loadEmailTemplate(templateName);
        const html = renderTemplate(template, data);

        const mailOptions = {
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to,
            subject,
            html,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('Email sent:', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('Email sending error:', error);
        return { success: false, error: error.message };
    }
};

// Send WhatsApp via Business API with Template
const sendWhatsAppBusinessAPITemplate = async (to, templateName, languageCode, parameters) => {
    const config = getWhatsappConfig();
    try {
        const response = await fetch(config.apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: to.replace(/[^0-9]/g, ''), // Remove non-numeric characters
                type: 'template',
                template: {
                    name: templateName,
                    language: {
                        code: languageCode || 'en'
                    },
                    components: parameters ? [
                        {
                            type: 'body',
                            parameters: parameters.map(param => ({
                                type: 'text',
                                text: param
                            }))
                        }
                    ] : []
                },
            }),
        });

        const result = await response.json();

        if (response.ok) {
            console.log('WhatsApp template sent via Business API:', result.messages?.[0]?.id);
            return { success: true, messageId: result.messages?.[0]?.id };
        } else {
            console.error('WhatsApp Business API template error:', result);
            return { success: false, error: result.error?.message || 'Unknown error' };
        }
    } catch (error) {
        console.error('WhatsApp Business API template error:', error);
        return { success: false, error: error.message };
    }
};

// Send WhatsApp via Business API (plain text - fallback)
const sendWhatsAppBusinessAPI = async (to, message) => {
    const config = getWhatsappConfig();
    try {
        const response = await fetch(config.apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: to.replace(/[^0-9]/g, ''), // Remove non-numeric characters
                type: 'text',
                text: {
                    body: message,
                },
            }),
        });

        const result = await response.json();

        if (response.ok) {
            console.log('WhatsApp sent via Business API:', result.messages?.[0]?.id);
            return { success: true, messageId: result.messages?.[0]?.id };
        } else {
            console.error('WhatsApp Business API error:', result);
            return { success: false, error: result.error?.message || 'Unknown error' };
        }
    } catch (error) {
        console.error('WhatsApp Business API error:', error);
        return { success: false, error: error.message };
    }
};

// Send WhatsApp (Business API Only)
export const sendWhatsApp = async (to, message) => {
    const config = getWhatsappConfig();
    try {
        // Check if WhatsApp Business API is configured
        if (config.apiUrl && config.accessToken) {
            return await sendWhatsAppBusinessAPI(to, message);
        }

        console.log('WhatsApp not configured, skipping WhatsApp notification');
        return { success: false, message: 'WhatsApp not configured' };
    } catch (error) {
        console.error('WhatsApp sending error:', error);
        return { success: false, error: error.message };
    }
};

// Send WhatsApp Template (for Business API)
export const sendWhatsAppTemplate = async (to, templateName, parameters, languageCode = 'en') => {
    const config = getWhatsappConfig();
    try {
        // Only Business API supports templates
        if (config.apiUrl && config.accessToken) {
            return await sendWhatsAppBusinessAPITemplate(to, templateName, languageCode, parameters);
        }

        console.log('WhatsApp Business API not configured, cannot send template');
        return { success: false, message: 'WhatsApp Business API required for templates' };
    } catch (error) {
        console.error('WhatsApp template sending error:', error);
        return { success: false, error: error.message };
    }
};

// Send OTP via WhatsApp
export const sendOTPWhatsApp = async (to, otp) => {
    const config = getWhatsappConfig();
    try {
        const templateName = 'login_vcgreen';

        // Check if WhatsApp API is configured
        if (!config.apiUrl || !config.accessToken) {
            console.log('WhatsApp not configured, falling back to plain text');
            const message = `🔐 *Your VCGreen Task Manager password reset OTP is:*\n\n*${otp}*\n\nThis OTP is valid for 15 minutes.\n\n⚠️ Do not share this code with anyone.`;
            return await sendWhatsApp(to, message);
        }

        // Format phone number and OTP
        const formattedPhone = to.replace(/[^0-9]/g, '');
        const otpText = String(otp);

        // Build template components
        const components = [
            {
                type: 'body',
                parameters: [{ type: 'text', text: otpText }]
            }
        ];

        // Add URL button parameter if template has button
        // This fixes the "Required parameter is missing" error
        components.push({
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: otpText }]
        });

        const payload = {
            messaging_product: 'whatsapp',
            to: formattedPhone,
            type: 'template',
            template: {
                name: templateName,
                language: { code: 'en' },
                components
            }
        };

        // Send template via WhatsApp Business API
        const response = await fetch(config.apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (response.ok) {
            console.log('OTP sent via WhatsApp template:', templateName, result.messages?.[0]?.id);
            return { success: true, messageId: result.messages?.[0]?.id };
        } else {
            console.error('WhatsApp template error:', result);
            console.log('Falling back to plain text message');

            // Fallback to plain text
            const message = `🔐 *Your VCGreen Task Manager password reset OTP is:*\n\n*${otp}*\n\nThis OTP is valid for 15 minutes.\n\n⚠️ Do not share this code with anyone.`;
            return await sendWhatsApp(to, message);
        }
    } catch (error) {
        console.error('OTP WhatsApp sending error:', error);

        // Fallback to plain text on any error
        try {
            const message = `🔐 *Your VCGreen Task Manager password reset OTP is:*\n\n*${otp}*\n\nThis OTP is valid for 15 minutes.\n\n⚠️ Do not share this code with anyone.`;
            return await sendWhatsApp(to, message);
        } catch (fallbackError) {
            console.error('Fallback also failed:', fallbackError);
            return { success: false, error: error.message };
        }
    }
};

// Notification functions for specific events


// Helper to get priority badge colors for email templates
const getPriorityColors = (priority) => {
    switch (priority) {
        case 'High': return { bg: '#fef2f2', color: '#dc2626' };
        case 'Medium': return { bg: '#fffbeb', color: '#d97706' };
        case 'Low': return { bg: '#f0fdf4', color: '#16a34a' };
        default: return { bg: '#f3f4f6', color: '#6b7280' };
    }
};

// Helper to get status badge colors for email templates
const getStatusColors = (status) => {
    switch (status) {
        case 'Completed': return { bg: '#f0fdf4', color: '#16a34a' };
        case 'In Progress': return { bg: '#eff6ff', color: '#2563eb' };
        case 'Pending': return { bg: '#fffbeb', color: '#d97706' };
        default: return { bg: '#f3f4f6', color: '#6b7280' };
    }
};

export const notifyTaskAssigned = async (task, assignedUser, createdByUser) => {
    const priorityColors = getPriorityColors(task.priority);
    const emailData = {
        userName: assignedUser.name,
        taskTitle: task.task,
        taskNumber: task.sno,
        assignedBy: createdByUser.name,
        dueDate: new Date(task.dueDate).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }),
        dueTime: task.targetTime ? new Date(`2000-01-01T${task.targetTime}`).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: 'numeric',
            hour12: true
        }) : '',
        priority: task.priority,
        priorityBg: priorityColors.bg,
        priorityColor: priorityColors.color,
        notes: task.notes || 'No additional notes',
        taskLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/tasks`,
    };

    const whatsappMessage = `🔔 *New Task Assigned*\n\n📋 *Task*: ${task.task}\n👤 *Assigned by*: ${createdByUser.name}\n📅 *Due*: ${emailData.dueDate}\n⚡ *Priority*: ${task.priority}\n\nView details: ${emailData.taskLink}`;

    // Send email
    const emailResult = await sendEmail(
        assignedUser.email,
        `New Task Assigned: ${task.task}`,
        'taskAssigned',
        emailData
    );

    let whatsappResult = { success: false, message: 'WhatsApp not configured or user has no number' };

    // Send WhatsApp if user has WhatsApp number
    if (assignedUser.whatsapp) {
        const config = getWhatsappConfig();
        // Use template if configured AND Business API is available, otherwise fallback to plain text
        // Use user provided template name
        const templateName = 'fraud_alert_2'; // Updated template name

        if (config.apiUrl && config.accessToken) {
            // New 7-variable template
            // {{1}} - Assigned User Name
            // {{2}} - Task ID
            // {{3}} - Task Name
            // {{4}} - Assigned By
            // {{5}} - Priority
            // {{6}} - Due Date & Time
            // {{7}} - Notes

            const dueDateTime = `${emailData.dueDate} ${emailData.dueTime}`.trim();

            whatsappResult = await sendWhatsAppTemplate(
                assignedUser.whatsapp,
                templateName,
                [
                    assignedUser.name,     // {{1}}
                    task.sno.toString(),   // {{2}}
                    task.task,             // {{3}}
                    createdByUser.name,    // {{4}}
                    task.priority,         // {{5}}
                    dueDateTime,           // {{6}}
                    task.notes || 'No notes' // {{7}}
                ],
                'en_US'
            );
        } else {
            whatsappResult = await sendWhatsApp(assignedUser.whatsapp, whatsappMessage);
        }
    }

    return { email: emailResult, whatsapp: whatsappResult };
};

export const notifyStatusChanged = async (task, updatingUser, recipientUser, newStatus) => {
    const statusColors = getStatusColors(newStatus);
    const emailData = {
        userName: recipientUser.name,
        taskTitle: task.task,
        taskNumber: task.sno,
        assignedTo: updatingUser.name,
        newStatus: newStatus,
        statusBg: statusColors.bg,
        statusColor: statusColors.color,
        dueDate: new Date(task.dueDate).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }),
        dueTime: task.targetTime ? new Date(`2000-01-01T${task.targetTime}`).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: 'numeric',
            hour12: true
        }) : '',
        notes: task.notes || 'No additional notes',
        taskLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/assigned-tasks`,
    };

    const statusEmoji = newStatus === 'Completed' ? '✅' : '🔄';
    const whatsappMessage = `${statusEmoji} *Task Status Updated*\n\n📋 *Task*: ${task.task}\n👤 *Updated by*: ${updatingUser.name}\n📊 *New Status*: ${newStatus}\n\nView details: ${emailData.taskLink}`;

    // Send email
    await sendEmail(
        recipientUser.email,
        `Task Status Updated: ${task.task}`,
        'statusChanged',
        emailData
    );

    // Send WhatsApp if user has WhatsApp number
    if (recipientUser.whatsapp) {
        const config = getWhatsappConfig();
        // Use template if configured AND Business API is available, otherwise fallback to plain text
        // Use user provided template name
        const templateName = 'task_status_alert'; // Updated template name

        if (config.apiUrl && config.accessToken) {
            // New 7-variable template
            // {{1}} - Recipient Name (Created By)
            // {{2}} - New Status
            // {{3}} - Task ID
            // {{4}} - Task Name
            // {{5}} - Updated By Name
            // {{6}} - Due Date & Time (using existing logic if available or just date)
            // {{7}} - Notes

            // Construct Due Date & Time string for context
            const dueDateTime = task.targetTime
                ? `${new Date(task.dueDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} ${new Date('2000-01-01T' + task.targetTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true })}`
                : new Date(task.dueDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

            await sendWhatsAppTemplate(
                recipientUser.whatsapp,
                templateName,
                [
                    recipientUser.name,    // {{1}}
                    newStatus,             // {{2}}
                    task.sno.toString(),   // {{3}}
                    task.task,             // {{4}}
                    updatingUser.name,     // {{5}} Updated By
                    dueDateTime,           // {{6}}
                    task.notes || 'No notes' // {{7}}
                ],
                'en'
            );
        } else {
            await sendWhatsApp(recipientUser.whatsapp, whatsappMessage);
        }
    }
};

export const notifyTaskApproved = async (task, assignedUser, approvedByUser) => {
    const emailData = {
        userName: assignedUser.name,
        taskTitle: task.task,
        taskNumber: task.sno,
        approvedBy: approvedByUser.name,
        approvedDate: new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }),
        taskLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/tasks`,
    };

    const whatsappMessage = `✅ *Task Approved*\n\n📋 *Task*: ${task.task}\n👤 *Approved by*: ${approvedByUser.name}\n📅 *Date*: ${emailData.approvedDate}\n\nGreat work! 🎉`;

    // Send email
    await sendEmail(
        assignedUser.email,
        `Task Approved: ${task.task}`,
        'taskApproved',
        emailData
    );

    // Send WhatsApp if user has WhatsApp number
    if (assignedUser.whatsapp) {
        const config = getWhatsappConfig();
        // Use template if configured AND Business API is available, otherwise fallback to plain text
        // Use user provided template name
        const templateName = 'task_approved_alert'; // Updated template name

        if (config.apiUrl && config.accessToken) {
            // New 4-variable template
            // {{1}} - Recipient Name (Assigned User)
            // {{2}} - Task ID
            // {{3}} - Task Name
            // {{4}} - Approved By Name

            await sendWhatsAppTemplate(
                assignedUser.whatsapp,
                templateName,
                [
                    assignedUser.name,         // {{1}}
                    task.sno.toString(),       // {{2}}
                    task.task,                 // {{3}}
                    approvedByUser.name        // {{4}}
                ],
                'en'
            );
        } else {
            await sendWhatsApp(assignedUser.whatsapp, whatsappMessage);
        }
    }
};

export const notifyTaskRejected = async (task, assignedUser, rejectedByUser, reason) => {
    const emailData = {
        userName: assignedUser.name,
        taskTitle: task.task,
        taskNumber: task.sno,
        rejectedBy: rejectedByUser.name,
        rejectionReason: reason || 'No specific reason provided',
        rejectedDate: new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }),
        taskLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/tasks`,
    };

    const whatsappMessage = `❌ *Task Returned*\n\n📋 *Task*: ${task.task}\n👤 *Returned by*: ${rejectedByUser.name}\n📝 *Reason*: ${reason || 'No specific reason'}\n\nPlease review and resubmit.\n\nView details: ${emailData.taskLink}`;

    // Send email
    await sendEmail(
        assignedUser.email,
        `Task Returned: ${task.task}`,
        'taskRejected',
        emailData
    );

    // Send WhatsApp if user has WhatsApp number
    if (assignedUser.whatsapp) {
        const config = getWhatsappConfig();
        // Use template if configured AND Business API is available, otherwise fallback to plain text
        // Use user provided template name
        const templateName = 'task_rejected_return_alert'; // Updated template name

        if (config.apiUrl && config.accessToken) {
            // New 5-variable template
            // {{1}} - Recipient Name (Assigned User)
            // {{2}} - Task ID
            // {{3}} - Task Name
            // {{4}} - Rejected By Name
            // {{5}} - Reason/Notes

            await sendWhatsAppTemplate(
                assignedUser.whatsapp,
                templateName,
                [
                    assignedUser.name,          // {{1}}
                    task.sno.toString(),        // {{2}}
                    task.task,                  // {{3}}
                    rejectedByUser.name,        // {{4}}
                    reason || 'Revision Requested' // {{5}}
                ],
                'en'
            );
        } else {
            await sendWhatsApp(assignedUser.whatsapp, whatsappMessage);
        }
    }
};

export const notifyTaskComment = async (task, commentingUser, commentText) => {
    // Determine recipients (everyone involved except the commenter)
    const recruitingEmails = [];
    const recipients = [];

    // Check Creator
    if (task.createdBy && task.createdBy.email !== commentingUser.email) {
        recipients.push(task.createdBy);
        recruitingEmails.push(task.createdBy.email);
    }

    // Check Assignee
    if (task.assignedTo && task.assignedTo.email !== commentingUser.email) {
        if (!recruitingEmails.includes(task.assignedTo.email)) {
            recipients.push(task.assignedTo);
            recruitingEmails.push(task.assignedTo.email);
        }
    }

    // Process notifications
    for (const recipient of recipients) {
        // Send email
        if (recipient.email) {
            const emailData = {
                userName: recipient.name,
                taskTitle: task.task,
                taskNumber: task.sno,
                commentedBy: commentingUser.name,
                commentText: commentText,
                taskLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/tasks`,
            };
            await sendEmail(
                recipient.email,
                `💬 New Comment on Task: ${task.task}`,
                'taskComment',
                emailData
            ).catch(err => console.error(`Failed to send comment email to ${recipient.name}:`, err));
        }

        // Send WhatsApp if user has WhatsApp number
        if (recipient.whatsapp) {
            const config = getWhatsappConfig();
            const templateName = 'task_comment_alert';

            if (config.apiUrl && config.accessToken) {
                await sendWhatsAppTemplate(
                    recipient.whatsapp,
                    templateName,
                    [
                        recipient.name,          // {{1}}
                        task.sno.toString(),     // {{2}}
                        task.task,               // {{3}}
                        commentingUser.name,     // {{4}}
                        commentText              // {{5}}
                    ],
                    'en'
                ).catch(err => console.error(`Failed to send comment WhatsApp to ${recipient.name}:`, err));
            } else {
                const whatsappMessage = `💬 *New Comment on Task*\n\n📋 *Task*: ${task.task}\n👤 *Comment by*: ${commentingUser.name}\n📝 *Comment*: ${commentText}`;
                await sendWhatsApp(recipient.whatsapp, whatsappMessage)
                    .catch(err => console.error(`Failed to send comment WhatsApp text to ${recipient.name}:`, err));
            }
        }
    }
};
