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

// Technician: GET /api/services/technician?email=...
app.get("/api/services/technician", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "Technician email is required" });
    }

    const { services } = await getCollections();
    const list = await services
      .find({ technicianEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    let approved = 0;
    let pending = 0;
    let rejected = 0;

    for (const item of technicianServices) {
      const st = String(
        item.approvalStatus || item.status || "pending",
      ).toLowerCase();
      if (st === "approved") approved += 1;
      else if (st === "rejected") rejected += 1;
      else pending += 1;
    }

    res.json({
      services: list,
      stats: {
        total: list.length,
        approved,
        pending,
        rejected,
      },
    });
  } catch (error) {
    console.error("GET /api/services/technician error:", error);
    res.status(500).json({ message: "Failed to load technician services" });
  }
});

// Technician: PATCH /api/services/:id (Edit service -> resets approvalStatus to "pending", OR toggle isAvailable)
app.patch("/api/services/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service ID" });
    }

    const { services } = await getCollections();
    const existing = await services.findOne({ _id: new ObjectId(id) });

    if (!existing) {
      return res.status(404).json({ message: "Service not found" });
    }

    const technicianEmail = String(req.body?.technicianEmail || "")
      .trim()
      .toLowerCase();
    if (
      technicianEmail &&
      String(existing.technicianEmail || "").toLowerCase() !== technicianEmail
    ) {
      return res
        .status(403)
        .json({ message: "You can only update your own services" });
    }

    const allowedCategories = [
      "Smartphone",
      "Laptop & PC",
      "AC",
      "Refrigerator",
      "TV",
      "Washing Machine",
      "Electrical",
    ];
    const allowedModes = ["Home Visit", "Shop Drop-off"];

    const updateFields = { updatedAt: new Date() };
    let hasContentEdits = false;

    if (req.body?.title !== undefined) {
      const title = String(req.body.title).trim();
      if (title.length < 4) {
        return res
          .status(400)
          .json({ message: "Title must be at least 4 characters" });
      }
      updateFields.title = title;
      hasContentEdits = true;
    }

    if (req.body?.category !== undefined) {
      const category = String(req.body.category).trim();
      if (!allowedCategories.includes(category)) {
        return res.status(400).json({ message: "Invalid service category" });
      }
      updateFields.category = category;
      hasContentEdits = true;
    }

    if (req.body?.description !== undefined) {
      const description = String(req.body.description).trim();
      if (description.length < 15) {
        return res
          .status(400)
          .json({ message: "Description must be at least 15 characters" });
      }
      updateFields.description = description;
      hasContentEdits = true;
    }

    if (req.body?.image !== undefined) {
      const image = String(req.body.image).trim();
      if (!image) {
        return res.status(400).json({ message: "Service image is required" });
      }
      updateFields.image = image;
      hasContentEdits = true;
    }

    if (req.body?.basePrice !== undefined) {
      const parsedPrice = Number(req.body.basePrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        return res
          .status(400)
          .json({ message: "Base price must be a positive number" });
      }
      updateFields.basePrice = parsedPrice;
      hasContentEdits = true;
    }

    if (req.body?.estimatedDuration !== undefined) {
      const duration = String(req.body.estimatedDuration).trim();
      if (!duration) {
        return res
          .status(400)
          .json({ message: "Estimated duration is required" });
      }
      updateFields.estimatedDuration = duration;
      hasContentEdits = true;
    }

    if (req.body?.serviceMode !== undefined) {
      const serviceMode = String(req.body.serviceMode).trim();
      if (!allowedModes.includes(serviceMode)) {
        return res.status(400).json({ message: "Invalid service mode" });
      }
      updateFields.serviceMode = serviceMode;
      hasContentEdits = true;
    }

    if (req.body?.serviceArea !== undefined) {
      const serviceArea = String(req.body.serviceArea).trim();
      if (!serviceArea) {
        return res.status(400).json({ message: "Service area is required" });
      }
      updateFields.serviceArea = serviceArea;
      hasContentEdits = true;
    }

    if (req.body?.isAvailable !== undefined) {
      updateFields.isAvailable = Boolean(req.body.isAvailable);
    }

    if (!hasContentEdits && req.body?.isAvailable === undefined) {
      return res.status(400).json({ message: "No valid fields to update" });
    }

    // Per requirements: editing service details resets approvalStatus back to "pending"
    if (hasContentEdits) {
      updateFields.approvalStatus = "pending";
    }

    const updated = await services.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updateFields },
      { returnDocument: "after" }
    );

    res.json({
      message: hasContentEdits
        ? "Service updated and sent for admin re-approval"
        : `Service marked as ${
            updated.isAvailable ? "available" : "unavailable"
          }`,
      service: updated,
    });
  } catch (error) {
    console.error("PATCH /api/services/:id error:", error);
    res.status(500).json({ message: "Failed to update service" });
  }
});

// Technician: DELETE /api/services/:id
app.delete("/api/services/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service ID" });
    }

    const { services } = await getCollections();
    const existing = await services.findOne({ _id: new ObjectId(id) });

    if (!existing) {
      return res.status(404).json({ message: "Service not found" });
    }

    const technicianEmail = String(
      req.query.email || req.body?.technicianEmail || ""
    )
      .trim()
      .toLowerCase();
    if (
      technicianEmail &&
      String(existing.technicianEmail || "").toLowerCase() !== technicianEmail
    ) {
      return res
        .status(403)
        .json({ message: "You can only delete your own services" });
    }

    await services.deleteOne({ _id: new ObjectId(id) });

    res.json({
      message: "Service deleted successfully",
      deletedId: id,
    });
  } catch (error) {
    console.error("DELETE /api/services/:id error:", error);
    res.status(500).json({ message: "Failed to delete service" });
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
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
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
      },
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

    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();
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
      { $set: updateFields },
    );

    // Keep technicianName synced on their service listings if name changed
    if (
      (existingUser.role || "").toLowerCase() === "technician" &&
      trimmedName !== existingUser.name
    ) {
      await services.updateMany(
        { technicianEmail: existingUser.email },
        { $set: { technicianName: trimmedName } },
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
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
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
      { $set: { status: "cancelled", updatedAt } },
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

// Customer: GET /api/payments/customer?email=...
app.get("/api/payments/customer", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "Customer email is required" });
    }

    const { payments } = await getCollections();
    const list = await payments
      .find({ customerEmail: email })
      .sort({ paidAt: -1, createdAt: -1 })
      .toArray();

    res.json({ payments: list });
  } catch (error) {
    console.error("GET /api/payments/customer error:", error);
    res.status(500).json({ message: "Failed to load payment history" });
  }
});

// Technician: POST /api/services (creates new service with approvalStatus: "pending")
app.post("/api/services", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const category = String(req.body?.category || "").trim();
    const description = String(req.body?.description || "").trim();
    const image = String(req.body?.image || "").trim();
    const basePrice = Number(req.body?.basePrice);
    const estimatedDuration = String(
      req.body?.estimatedDuration || "1-2 hours",
    ).trim();
    const serviceMode = String(req.body?.serviceMode || "Home Visit").trim();
    const serviceArea = String(req.body?.serviceArea || "").trim();
    const technicianName = String(
      req.body?.technicianName || "Technician",
    ).trim();
    const technicianEmail = String(req.body?.technicianEmail || "")
      .trim()
      .toLowerCase();

    if (!title || !category || !description || !technicianEmail) {
      return res.status(400).json({
        message:
          "Title, category, description, and technicianEmail are required",
      });
    }

    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return res.status(400).json({
        message: "Base price must be a positive number",
      });
    }

    const { services } = await getCollections();
    const now = new Date();

    const newService = {
      title,
      category,
      description,
      image: image || "",
      basePrice,
      estimatedDuration,
      serviceMode,
      serviceArea,
      technicianName,
      technicianEmail,
      approvalStatus: "pending",
      isAvailable: true,
      createdAt: now,
      updatedAt: now,
    };

    const result = await services.insertOne(newService);

    res.status(201).json({
      message: "Service submitted for admin approval",
      service: {
        _id: result.insertedId,
        ...newService,
      },
    });
  } catch (error) {
    console.error("POST /api/services error:", error);
    res.status(500).json({ message: "Failed to create service" });
  }
});

// Technician: GET /api/bookings/technician?email=...
app.get("/api/bookings/technician", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "Technician email is required" });
    }

    const { bookings } = await getCollections();
    const list = await bookings
      .find({ technicianEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    let requested = 0;
    let accepted = 0;
    let inProgress = 0;
    let completed = 0;
    let earnings = 0;

    for (const item of list) {
      const status = (item.status || "requested").toLowerCase();
      if (status === "requested") requested += 1;
      else if (status === "accepted") accepted += 1;
      else if (status === "in-progress") inProgress += 1;
      else if (status === "completed") {
        completed += 1;
        if ((item.paymentStatus || "").toLowerCase() === "paid") {
          earnings += Number(item.finalAmount ?? item.basePrice ?? 0);
        }
      }
    }

    res.json({
      bookings: list,
      stats: {
        total: list.length,
        requested,
        accepted,
        inProgress,
        completed,
        earnings,
      },
    });
  } catch (error) {
    console.error("GET /api/bookings/technician error:", error);
    res
      .status(500)
      .json({ message: "Failed to load technician booking requests" });
  }
});

// Technician: PATCH /api/bookings/:id/status
app.patch("/api/bookings/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid booking ID" });
    }

    const nextStatus = String(req.body?.status || "")
      .trim()
      .toLowerCase();
    const technicianEmail = String(req.body?.technicianEmail || "")
      .trim()
      .toLowerCase();

    const allowedTargets = ["accepted", "rejected", "in-progress", "completed"];
    if (!allowedTargets.includes(nextStatus)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const { bookings } = await getCollections();
    const booking = await bookings.findOne({ _id: new ObjectId(id) });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (
      technicianEmail &&
      String(booking.technicianEmail || "").toLowerCase() !== technicianEmail
    ) {
      return res
        .status(403)
        .json({ message: "You are not assigned to this booking" });
    }

    const currentStatus = String(booking.status || "requested").toLowerCase();
    const validTransitions = {
      requested: ["accepted", "rejected"],
      accepted: ["in-progress"],
      "in-progress": ["completed"],
    };

    const allowedNext = validTransitions[currentStatus] || [];
    if (!allowedNext.includes(nextStatus)) {
      return res.status(400).json({
        message: `Cannot change status from "${currentStatus}" to "${nextStatus}"`,
      });
    }

    const updateFields = {
      status: nextStatus,
      updatedAt: new Date(),
    };

    if (
      nextStatus === "completed" &&
      req.body?.finalAmount !== undefined &&
      req.body?.finalAmount !== null &&
      req.body?.finalAmount !== ""
    ) {
      const parsedAmount = Number(req.body.finalAmount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res
          .status(400)
          .json({ message: "Final amount must be a positive number" });
      }
      updateFields.finalAmount = parsedAmount;
    }

    const result = await bookings.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updateFields },
      { returnDocument: "after" },
    );

    res.json({
      message: `Booking status updated to ${nextStatus}`,
      booking: result,
    });
  } catch (error) {
    console.error("PATCH /api/bookings/:id/status error:", error);
    res.status(500).json({ message: "Failed to update booking status" });
  }
});

// Admin: GET /api/admin/overview
app.get("/api/admin/overview", async (req, res) => {
  try {
    const { users, services, bookings } = await getCollections();

    const [allUsers, allServices, allBookings] = await Promise.all([
      users ? users.find({}).toArray() : Promise.resolve([]),
      services.find({}).sort({ createdAt: -1 }).toArray(),
      bookings.find({}).sort({ createdAt: -1 }).toArray(),
    ]);

    let totalCustomers = 0;
    let totalTechnicians = 0;
    let totalAdmins = 0;

    for (const u of allUsers) {
      const role = String(u.role || "customer").toLowerCase();
      if (role === "technician") totalTechnicians += 1;
      else if (role === "admin") totalAdmins += 1;
      else totalCustomers += 1;
    }

    let approvedServices = 0;
    let pendingServices = 0;
    let rejectedServices = 0;
    const recentPendingServices = [];

    for (const s of allServices) {
      const approval = String(
        s.approvalStatus || s.status || "pending",
      ).toLowerCase();

      if (approval === "approved") approvedServices += 1;
      else if (approval === "rejected") rejectedServices += 1;
      else {
        pendingServices += 1;
        if (recentPendingServices.length < 5) {
          recentPendingServices.push(s);
        }
      }
    }

    let activeBookings = 0;
    let completedBookings = 0;
    let paidBookings = 0;
    let totalRevenue = 0;

    for (const b of allBookings) {
      const status = String(b.status || "requested").toLowerCase();
      if (
        status === "requested" ||
        status === "accepted" ||
        status === "in-progress"
      ) {
        activeBookings += 1;
      } else if (status === "completed") {
        completedBookings += 1;
      }

      if (String(b.paymentStatus || "").toLowerCase() === "paid") {
        paidBookings += 1;
        totalRevenue += Number(b.finalAmount ?? b.basePrice ?? 0);
      }
    }

    res.json({
      stats: {
        totalUsers: allUsers.length,
        totalCustomers,
        totalTechnicians,
        totalAdmins,
        totalServices: allServices.length,
        approvedServices,
        pendingServices,
        rejectedServices,
        totalBookings: allBookings.length,
        activeBookings,
        completedBookings,
        paidBookings,
        totalRevenue,
      },
      recentPendingServices,
      recentBookings: allBookings.slice(0, 5),
    });
  } catch (error) {
    console.error("GET /api/admin/overview error:", error);
    res.status(500).json({ message: "Failed to load admin overview data" });
  }
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`FixMate server running on http://localhost:${port}`);
  });
}

export default app;
