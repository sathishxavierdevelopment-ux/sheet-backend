import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "./config/database.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";


import authRoutes from "./routes/auth.js";
import taskRoutes from "./routes/tasks.js";
import approvalRoutes from "./routes/approvals.js";
import reportRoutes from "./routes/reports.js";
import departmentRoutes from "./routes/departments.js";
import userRoutes from "./routes/users.js";
import roleRoutes from "./routes/roles.js";
import passwordResetRoutes from "./routes/passwordReset.js";

dotenv.config();
// Connect to database - will be cached in serverless environment
const app = express();

app.use(
  cors({
    origin: [
      "https://sheet-frontend-six.vercel.app",
      "https://sheet-frontend-git-dev-sathish-team.vercel.app",
      "https://task.vcgreen.in",
      "https://placetest.in",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5714"
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })
);

app.options("*", cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure MongoDB is connected before handling API requests
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error("Database middleware error:", error);

    res.status(500).json({
      success: false,
      error: "Database connection failed",
    });
  }
});

app.get("/", (req, res) => {
  res.json({ message: "Task Management API is running" });
});

// Environment variables check endpoint
app.get("/api/env-check", (req, res) => {
  res.json({
    success: true,
    environment: {
      NODE_ENV: process.env.NODE_ENV || 'not set',
      hasMongoUri: !!process.env.MONGODB_URI,
      mongoUriLength: process.env.MONGODB_URI?.length || 0,
      hasJwtSecret: !!process.env.JWT_SECRET,
      jwtSecretLength: process.env.JWT_SECRET?.length || 0,
      jwtExpiresIn: process.env.JWT_EXPIRES_IN || 'not set',
      hasFrontendUrl: !!process.env.FRONTEND_URL,
      frontendUrl: process.env.FRONTEND_URL || 'not set',
      port: process.env.PORT || 'not set'
    },
    message: "Check if all required variables are set. MongoDB URI and JWT Secret should have length > 0"
  });
});

// Test endpoint for debugging Vercel deployment
app.get("/api/test", async (req, res) => {
  try {
    const db = await connectDB();

    const dbState = db.connection.readyState;

    const states = {
      0: "disconnected",
      1: "connected",
      2: "connecting",
      3: "disconnecting"
    };

    res.json({
      success: true,
      database: {
        state: states[dbState] || "unknown",
        stateCode: dbState,
        name: db.connection.name
      },
      environment: {
        nodeEnv: process.env.NODE_ENV,
        hasMongoUri: !!process.env.MONGODB_URI,
        hasJwtSecret: !!process.env.JWT_SECRET,
        jwtExpires: process.env.JWT_EXPIRES_IN
      }
    });
  } catch (error) {
    console.error("TEST DATABASE ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/approvals", approvalRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/departments", departmentRoutes);
app.use("/api/users", userRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/password-reset", passwordResetRoutes);

app.use(notFound);
app.use(errorHandler);

export default app; // ✅ REQUIRED FOR VERCEL
