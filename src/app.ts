import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth";
import astrologerRoutes from "./routes/astrologers";
import bookingRoutes from "./routes/bookings";
import paymentRoutes from "./routes/payments";
import questionRoutes from "./routes/questions";
import templateRoutes from "./routes/templates";
import userRoutes from "./routes/users";

export const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3002",
      "http://localhost:5173",
      "http://localhost:8081",
      "http://10.89.21.117:3001",
      "http://10.89.21.117:3002",
    ],
    credentials: true,
  })
);
app.use(express.json());

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use("/auth", authRoutes);
app.use("/astrologers", astrologerRoutes);
app.use("/bookings", bookingRoutes);
app.use("/questions", questionRoutes);
app.use("/payments", paymentRoutes);
app.use("/templates", templateRoutes);
app.use("/", userRoutes);

app.get("/api/hello", (req, res) => {
  res.json({
    message: "Hello World",
  });
});
