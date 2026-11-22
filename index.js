import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const port = process.env.PORT || 8000;

const allowedOrigins = Array.from(
  new Set([
    "http://localhost:3000",
    ...(process.env.CLIENT_URL || "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  ]),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI);
let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    dbPromise = client.connect().then(() => {
      console.log("Connected to MongoDB (fixmatedb)");
      return client.db("fixmatedb");
    });
  }
  return dbPromise;
}

async function getCollections() {
  const db = await getDb();
  return {
    users: db.collection("user"),
    services: db.collection("services"),
    bookings: db.collection("bookings"),
    payments: db.collection("payments"),
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "FixMate API server is running",
  });
});

app.get("/api/health", async (req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Database health check failed:", error);
    res
      .status(500)
      .json({ status: "error", message: "Database connection failed" });
  }
});

// Public: GET /api/services (approved & available only, newest first)
app.get("/api/services", async (req, res) => {
  try {
    const { services } = await getCollections();
    const limit = Number.parseInt(req.query.limit, 10);

    let cursor = services
      .find({ approvalStatus: "approved", isAvailable: true })
      .sort({ createdAt: -1 });

    if (Number.isInteger(limit) && limit > 0) {
      cursor = cursor.limit(limit);
    }

    const list = await cursor.toArray();
    res.json(list);
  } catch (error) {
    console.error("GET /api/services error:", error);
    res.status(500).json({ message: "Failed to fetch repair services" });
  }
});

// Public: GET /api/services/:id (approved & available + technician summary)
app.get("/api/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Service not found" });
    }

    const { services, users } = await getCollections();
    const service = await services.findOne({
      _id: new ObjectId(id),
      approvalStatus: "approved",
      isAvailable: true,
    });

    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }

    const technicianUser = await users.findOne(
      { email: service.technicianEmail },
      { projection: { name: 1, image: 1, area: 1, bio: 1 } }
    );

    res.json({
      ...service,
      technician: {
        name: technicianUser?.name || service.technicianName || "Technician",
        image: technicianUser?.image || "",
        area: technicianUser?.area || service.serviceArea || "",
        bio: technicianUser?.bio || "",
      },
    });
  } catch (error) {
    console.error("GET /api/services/:id error:", error);
    res.status(500).json({ message: "Failed to fetch service details" });
  }
});

// Bookings: POST /api/bookings (create a new repair request)
app.post("/api/bookings", async (req, res) => {
  try {
    const {
      serviceId,
      customerName,
      customerEmail,
      customerPhone,
      address,
      preferredDate,
      problemDescription,
    } = req.body || {};

    if (!serviceId || !ObjectId.isValid(serviceId)) {
      return res.status(400).json({ message: "Invalid service ID" });
    }

    if (!customerEmail || typeof customerEmail !== "string") {
      return res
        .status(401)
        .json({ message: "Customer authentication required" });
    }

    if (!customerPhone || String(customerPhone).trim().length < 7) {
      return res
        .status(400)
        .json({ message: "Please provide a valid phone number" });
    }

    if (!address || String(address).trim().length < 5) {
      return res
        .status(400)
        .json({ message: "Please provide a valid service address" });
    }

    if (!preferredDate) {
      return res
        .status(400)
        .json({ message: "Please choose a preferred date" });
    }

    const dateOnly = String(preferredDate).slice(0, 10);
    const parsedDate = new Date(preferredDate);
    const endOfPreferredDay = new Date(`${dateOnly}T23:59:59.999Z`);
    if (
      Number.isNaN(parsedDate.getTime()) ||
      Number.isNaN(endOfPreferredDay.getTime()) ||
      endOfPreferredDay < new Date()
    ) {
      return res
        .status(400)
        .json({ message: "Preferred date must be today or a future date" });
    }

    if (!problemDescription || String(problemDescription).trim().length < 20) {
      return res.status(400).json({
        message: "Problem description must be at least 20 characters",
      });
    }

    const { users, services, bookings } = await getCollections();
    const normalizedEmail = customerEmail.trim().toLowerCase();

    // Verify customer role from DB
    const dbUser = await users.findOne({ email: normalizedEmail });
    const userRole = (dbUser?.role || "").toLowerCase();
    if (!dbUser || userRole !== "customer") {
      return res
        .status(403)
        .json({ message: "Only customers can request a repair" });
    }

    // Verify service exists, is approved, and is available
    const service = await services.findOne({
      _id: new ObjectId(serviceId),
      approvalStatus: "approved",
      isAvailable: true,
    });

    if (!service) {
      return res
        .status(404)
        .json({ message: "Service is not available for booking" });
    }

    // Prevent duplicate active requests (requested, accepted, in-progress)
    const existingActiveBooking = await bookings.findOne({
      serviceId: String(service._id),
      customerEmail: dbUser.email,
      status: { $in: ["requested", "accepted", "in-progress"] },
    });

    if (existingActiveBooking) {
      return res.status(409).json({
        message: "You already have an active request for this service",
      });
    }

    const basePrice = Number(service.basePrice) || 0;

    const newBooking = {
      serviceId: String(service._id),
      serviceTitle: service.title,
      serviceImage: service.image || "",
      category: service.category,
      basePrice,
      technicianName: service.technicianName,
      technicianEmail: service.technicianEmail,
      customerName: dbUser.name || String(customerName || "").trim(),
      customerEmail: dbUser.email,
      customerPhone: String(customerPhone).trim(),
      address: String(address).trim(),
      preferredDate: parsedDate,
      problemDescription: String(problemDescription).trim(),
      status: "requested",
      finalAmount: basePrice,
      paymentStatus: "unpaid",
      createdAt: new Date(),
    };

    const result = await bookings.insertOne(newBooking);

    res.status(201).json({
      message: "Repair request submitted successfully",
      booking: {
        _id: result.insertedId,
        ...newBooking,
      },
    });
  } catch (error) {
    console.error("POST /api/bookings error:", error);
    res.status(500).json({ message: "Failed to submit repair request" });
  }
});

// Profile: GET /api/users/profile?email=...
app.get("/api/users/profile", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "User email is required" });
    }

    const { users } = await getCollections();
    const user = await users.findOne(
      { email },
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          phone: 1,
          area: 1,
          bio: 1,
          createdAt: 1,
        },
      }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      user: {
        _id: user._id,
        name: user.name || "",
        email: user.email,
        image: user.image || "",
        role: user.role || "customer",
        phone: user.phone || "",
        area: user.area || "",
        bio: user.bio || "",
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error("GET /api/users/profile error:", error);
    res.status(500).json({ message: "Failed to load profile" });
  }
});

// Profile: PATCH /api/users/profile (name, image, phone, area, bio only — role/email locked)
app.patch("/api/users/profile", async (req, res) => {
  try {
    const { email, name, image, phone, area, bio } = req.body || {};

    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail) {
      return res.status(400).json({ message: "User email is required" });
    }

    const trimmedName = String(name || "").trim();
    if (trimmedName.length < 2) {
      return res
        .status(400)
        .json({ message: "Name must be at least 2 characters" });
    }

    const trimmedImage = String(image || "").trim();
    if (
      trimmedImage &&
      !trimmedImage.startsWith("http://") &&
      !trimmedImage.startsWith("https://")
    ) {
      return res
        .status(400)
        .json({ message: "Photo URL must start with http:// or https://" });
    }

    const { users, services } = await getCollections();
    const existingUser = await users.findOne({ email: normalizedEmail });

    if (!existingUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const updateFields = {
      name: trimmedName,
      image: trimmedImage,
      phone: String(phone || "").trim(),
      area: String(area || "").trim(),
      bio: String(bio || "").trim(),
      updatedAt: new Date(),
    };

    await users.updateOne(
      { email: existingUser.email },
      { $set: updateFields }
    );

    // Keep technicianName synced on their service listings if name changed
    if (
      (existingUser.role || "").toLowerCase() === "technician" &&
      trimmedName !== existingUser.name
    ) {
      await services.updateMany(
        { technicianEmail: existingUser.email },
        { $set: { technicianName: trimmedName } }
      );
    }

    res.json({
      message: "Profile updated successfully",
      user: {
        _id: existingUser._id,
        email: existingUser.email,
        role: existingUser.role || "customer",
        ...updateFields,
      },
    });
  } catch (error) {
    console.error("PATCH /api/users/profile error:", error);
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// Customer: GET /api/bookings/customer?email=...
app.get("/api/bookings/customer", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "Customer email is required" });
    }

    const { bookings } = await getCollections();
    const list = await bookings
      .find({ customerEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    const activeStatuses = new Set(["requested", "accepted", "in-progress"]);
    let active = 0;
    let completed = 0;
    let unpaidCompleted = 0;
    let totalSpent = 0;

    for (const item of list) {
      const status = (item.status || "").toLowerCase();
      const paymentStatus = (item.paymentStatus || "unpaid").toLowerCase();

      if (activeStatuses.has(status)) active += 1;
      if (status === "completed") {
        completed += 1;
        if (paymentStatus !== "paid") unpaidCompleted += 1;
      }
      if (paymentStatus === "paid") {
        totalSpent += Number(item.finalAmount ?? item.basePrice ?? 0);
      }
    }

    res.json({
      bookings: list,
      stats: {
        total: list.length,
        active,
        completed,
        unpaidCompleted,
        totalSpent,
      },
    });
  } catch (error) {
    console.error("GET /api/bookings/customer error:", error);
    res.status(500).json({ message: "Failed to load customer bookings" });
  }
});

// Customer: PATCH /api/bookings/:id/cancel (only own booking & only while "requested")
app.patch("/api/bookings/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;
    const customerEmail = String(req.body?.customerEmail || "")
      .trim()
      .toLowerCase();

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid booking ID" });
    }

    if (!customerEmail) {
      return res.status(401).json({ message: "Customer email is required" });
    }

    const { bookings } = await getCollections();
    const booking = await bookings.findOne({ _id: new ObjectId(id) });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if ((booking.customerEmail || "").toLowerCase() !== customerEmail) {
      return res
        .status(403)
        .json({ message: "You can only cancel your own repair requests" });
    }

    if ((booking.status || "").toLowerCase() !== "requested") {
      return res.status(400).json({
        message: "Only requests in 'requested' status can be cancelled",
      });
    }

    const updatedAt = new Date();
    await bookings.updateOne(
      { _id: booking._id },
      { $set: { status: "cancelled", updatedAt } }
    );

    res.json({
      message: "Repair request cancelled successfully",
      booking: {
        ...booking,
        status: "cancelled",
        updatedAt,
      },
    });
  } catch (error) {
    console.error("PATCH /api/bookings/:id/cancel error:", error);
    res.status(500).json({ message: "Failed to cancel repair request" });
  }
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`FixMate server running on http://localhost:${port}`);
  });
}

export default app;
