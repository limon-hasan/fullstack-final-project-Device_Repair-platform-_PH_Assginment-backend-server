import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;
const STRIPE_CURRENCY = String(process.env.STRIPE_CURRENCY || "usd")
  .trim()
  .toLowerCase();

const app = express();
const port = process.env.PORT || 8000;

const ALLOWED_CATEGORIES = [
  "Smartphone",
  "Laptop & PC",
  "AC",
  "Refrigerator",
  "TV",
  "Washing Machine",
  "Electrical",
];

const ALLOWED_SERVICE_MODES = ["Home Visit", "Shop Drop-off"];

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
    sessions: db.collection("session"),
    services: db.collection("services"),
    bookings: db.collection("bookings"),
    payments: db.collection("payments"),
  };
}

// ==================== Auth & Role Middlewares ====================

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ message: "Unauthorized: Missing Bearer token" });
    }

    const token = authHeader.split(" ")[1]?.trim();
    if (!token) {
      return res.status(401).json({ message: "Unauthorized: Token not found" });
    }

    const { sessions, users } = await getCollections();
    const session = await sessions.findOne({ token });

    if (!session) {
      return res.status(401).json({ message: "Unauthorized: Invalid token" });
    }

    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      return res.status(401).json({ message: "Unauthorized: Session expired" });
    }

    const userId = session.userId;
    const userQuery = ObjectId.isValid(userId)
      ? {
          $or: [{ _id: new ObjectId(userId) }, { _id: userId }, { id: userId }],
        }
      : { $or: [{ _id: userId }, { id: userId }] };

    const user = await users.findOne(userQuery);
    if (!user) {
      return res.status(401).json({ message: "Unauthorized: User not found" });
    }

    req.user = {
      ...user,
      email: String(user.email || "")
        .trim()
        .toLowerCase(),
      role: String(user.role || "customer")
        .trim()
        .toLowerCase(),
    };
    next();
  } catch (error) {
    console.error("verifyToken error:", error);
    return res.status(401).json({ message: "Unauthorized" });
  }
};

// Must be called after verifyToken
const verifyCustomer = (req, res, next) => {
  if (req.user?.role !== "customer") {
    return res.status(403).json({ message: "Forbidden: Customers only" });
  }
  next();
};

const verifyTechnician = (req, res, next) => {
  if (req.user?.role !== "technician") {
    return res.status(403).json({ message: "Forbidden: Technicians only" });
  }
  next();
};

const verifyAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Forbidden: Admins only" });
  }
  next();
};

app.get("/api/auth/me", verifyToken, (req, res) => {
  res.json({
    ok: true,
    user: {
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
    },
  });
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// ==========================================
// PUBLIC & TECHNICIAN SERVICE ROUTES
// ==========================================

// Public: GET /api/services (approved & available only, supports server-side search, filter, sort, limit)
app.get("/api/services", async (req, res) => {
  try {
    const { services } = await getCollections();
    const limit = Number.parseInt(req.query.limit, 10);
    const search = String(req.query.search || "").trim();
    const category = String(req.query.category || "").trim();
    const serviceMode = String(
      req.query.serviceMode || req.query.mode || "",
    ).trim();
    const sort = String(req.query.sort || "newest")
      .trim()
      .toLowerCase();

    const query = {
      approvalStatus: "approved",
      isAvailable: true,
    };

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { title: regex },
        { category: regex },
        { serviceArea: regex },
        { technicianName: regex },
      ];
    }

    if (category && category.toLowerCase() !== "all") {
      query.category = category;
    }

    if (serviceMode && serviceMode.toLowerCase() !== "all") {
      query.serviceMode = serviceMode;
    }

    let sortSpec = { createdAt: -1 };
    if (
      sort === "price_asc" ||
      sort === "price-asc" ||
      sort === "low-to-high"
    ) {
      sortSpec = { basePrice: 1, createdAt: -1 };
    } else if (
      sort === "price_desc" ||
      sort === "price-desc" ||
      sort === "high-to-low"
    ) {
      sortSpec = { basePrice: -1, createdAt: -1 };
    }

    let cursor = services.find(query).sort(sortSpec);

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

// Technician: GET /api/services/technician?email=... (MUST stay above /api/services/:id)
app.get(
  "/api/services/technician",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const requestedEmail = String(req.query.email || "")
        .trim()
        .toLowerCase();
      const targetEmail = requestedEmail || req.user.email;

      if (targetEmail !== req.user.email) {
        return res.status(403).json({
          message: "Forbidden: Cannot view another technician's services",
        });
      }

      const { services } = await getCollections();
      const list = await services
        .find({ technicianEmail: req.user.email })
        .sort({ createdAt: -1 })
        .toArray();

      let approved = 0;
      let pending = 0;
      let rejected = 0;

      for (const item of list) {
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
  },
);

// Public: GET /api/services/:id (approved & available service with technician summary)
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

    const technician = service.technicianEmail
      ? await users.findOne(
          { email: String(service.technicianEmail).toLowerCase() },
          { projection: { name: 1, image: 1, area: 1, bio: 1, email: 1 } },
        )
      : null;

    res.json({
      ...service,
      technician: technician
        ? {
            name: technician.name || service.technicianName || "Technician",
            image: technician.image || "",
            area: technician.area || service.serviceArea || "",
            bio: technician.bio || "",
          }
        : {
            name: service.technicianName || "Technician",
            image: "",
            area: service.serviceArea || "",
            bio: "",
          },
    });
  } catch (error) {
    console.error("GET /api/services/:id error:", error);
    res.status(500).json({ message: "Failed to fetch service details" });
  }
});

// Technician: POST /api/services (creates new service with approvalStatus: "pending", isAvailable: true)
app.post("/api/services", verifyToken, verifyTechnician, async (req, res) => {
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
      req.user.name || req.body?.technicianName || "Technician",
    ).trim();
    const technicianEmail = req.user.email;

    if (!title || title.length < 4) {
      return res
        .status(400)
        .json({ message: "Title must be at least 4 characters" });
    }

    if (!ALLOWED_CATEGORIES.includes(category)) {
      return res.status(400).json({ message: "Invalid service category" });
    }

    if (!ALLOWED_SERVICE_MODES.includes(serviceMode)) {
      return res.status(400).json({ message: "Invalid service mode" });
    }

    if (!description || description.length < 15) {
      return res
        .status(400)
        .json({ message: "Description must be at least 15 characters" });
    }

    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return res
        .status(400)
        .json({ message: "Base price must be a positive number" });
    }

    const { services } = await getCollections();
    const now = new Date();

    const newService = {
      title,
      category,
      description,
      image,
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

// Technician: PATCH /api/services/:id (Edit -> resets approvalStatus to "pending", OR toggle isAvailable)
app.patch(
  "/api/services/:id",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
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

      if (
        String(existing.technicianEmail || "").toLowerCase() !== req.user.email
      ) {
        return res.status(403).json({
          message: "Forbidden: You can only update your own services",
        });
      }

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
        if (!ALLOWED_CATEGORIES.includes(category)) {
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
        if (!ALLOWED_SERVICE_MODES.includes(serviceMode)) {
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

      if (hasContentEdits) {
        updateFields.approvalStatus = "pending";
      }

      const updated = await services.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updateFields },
        { returnDocument: "after" },
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
  },
);

// Technician: DELETE /api/services/:id
app.delete(
  "/api/services/:id",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
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

      if (
        String(existing.technicianEmail || "").toLowerCase() !== req.user.email
      ) {
        return res.status(403).json({
          message: "Forbidden: You can only delete your own services",
        });
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
  },
);

// ==========================================
// PROFILE ROUTES (ALL LOGGED-IN ROLES)
// ==========================================

// Profile: GET /api/users/profile?email=...
app.get("/api/users/profile", verifyToken, async (req, res) => {
  try {
    const requestedEmail = String(req.query.email || "")
      .trim()
      .toLowerCase();
    const targetEmail = requestedEmail || req.user.email;

    if (targetEmail !== req.user.email && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Forbidden: Cannot view another user's profile" });
    }

    const { users } = await getCollections();
    const user = await users.findOne(
      { email: targetEmail },
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
app.patch("/api/users/profile", verifyToken, async (req, res) => {
  try {
    const { name, image, phone, area, bio } = req.body || {};

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
    const existingUser = await users.findOne({ email: req.user.email });

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

    await users.updateOne({ _id: existingUser._id }, { $set: updateFields });

    if (
      (existingUser.role || "").toLowerCase() === "technician" &&
      trimmedName !== existingUser.name
    ) {
      await services.updateMany(
        { technicianEmail: req.user.email },
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

// ==========================================
// CUSTOMER BOOKING & PAYMENT ROUTES
// ==========================================

// Customer: POST /api/bookings (create a new repair request)
app.post("/api/bookings", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const {
      serviceId,
      customerName,
      customerPhone,
      address,
      preferredDate,
      problemDescription,
    } = req.body || {};

    if (!serviceId || !ObjectId.isValid(serviceId)) {
      return res.status(400).json({ message: "Invalid service ID" });
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

    const { services, bookings } = await getCollections();

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

    if (
      String(service.technicianEmail || "").toLowerCase() === req.user.email
    ) {
      return res
        .status(400)
        .json({ message: "You cannot book your own repair service" });
    }

    const existingBlockingBooking = await bookings.findOne({
      serviceId: String(service._id),
      customerEmail: req.user.email,
      $or: [
        { status: { $in: ["requested", "accepted", "in-progress"] } },
        { status: "completed", paymentStatus: { $ne: "paid" } },
      ],
    });

    if (existingBlockingBooking) {
      const isUnpaidCompleted =
        existingBlockingBooking.status === "completed" &&
        String(existingBlockingBooking.paymentStatus || "").toLowerCase() !==
          "paid";

      return res.status(409).json({
        message: isUnpaidCompleted
          ? "Please complete the payment for your previous booking of this service first"
          : "You already have an active request for this service",
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
      technicianEmail: String(service.technicianEmail || "")
        .trim()
        .toLowerCase(),
      customerName: req.user.name || String(customerName || "").trim(),
      customerEmail: req.user.email,
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

// Customer: GET /api/bookings/customer?email=... (ownership enforced via req.user.email)
app.get(
  "/api/bookings/customer",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const requestedEmail = String(req.query.email || "")
        .trim()
        .toLowerCase();

      if (requestedEmail && requestedEmail !== req.user.email) {
        return res.status(403).json({
          message: "Forbidden: Cannot view another customer's bookings",
        });
      }

      const { bookings } = await getCollections();
      const list = await bookings
        .find({ customerEmail: req.user.email })
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
  },
);

// Customer: PATCH /api/bookings/:id/cancel (only own booking & only while "requested")
app.patch(
  "/api/bookings/:id/cancel",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid booking ID" });
      }

      const { bookings } = await getCollections();
      const booking = await bookings.findOne({ _id: new ObjectId(id) });

      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      if ((booking.customerEmail || "").toLowerCase() !== req.user.email) {
        return res.status(403).json({
          message: "Forbidden: You can only cancel your own repair requests",
        });
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
  },
);

// Customer: GET /api/payments/customer?email=... (ownership enforced via req.user.email)
app.get(
  "/api/payments/customer",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const requestedEmail = String(req.query.email || "")
        .trim()
        .toLowerCase();

      if (requestedEmail && requestedEmail !== req.user.email) {
        return res.status(403).json({
          message: "Forbidden: Cannot view another customer's payments",
        });
      }

      const { payments } = await getCollections();
      const list = await payments
        .find({ customerEmail: req.user.email })
        .sort({ paidAt: -1, createdAt: -1 })
        .toArray();

      res.json({ payments: list });
    } catch (error) {
      console.error("GET /api/payments/customer error:", error);
      res.status(500).json({ message: "Failed to load payment history" });
    }
  },
);

// Customer: POST /api/payments/create-checkout-session
app.post(
  "/api/payments/create-checkout-session",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({
          message: "Stripe is not configured yet (missing STRIPE_SECRET_KEY)",
        });
      }

      const bookingId = String(req.body?.bookingId || "").trim();

      if (!bookingId || !ObjectId.isValid(bookingId)) {
        return res.status(400).json({ message: "Invalid booking ID" });
      }

      const { bookings } = await getCollections();
      const booking = await bookings.findOne({ _id: new ObjectId(bookingId) });

      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      if (
        String(booking.customerEmail || "").toLowerCase() !== req.user.email
      ) {
        return res.status(403).json({
          message: "Forbidden: You can only pay for your own bookings",
        });
      }

      if (String(booking.status || "").toLowerCase() !== "completed") {
        return res.status(400).json({
          message: "Payment is only available after the repair is completed",
        });
      }

      if (String(booking.paymentStatus || "").toLowerCase() === "paid") {
        return res
          .status(400)
          .json({ message: "This booking has already been paid" });
      }

      const amount = Number(booking.finalAmount ?? booking.basePrice ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ message: "Invalid booking amount" });
      }

      const unitAmount = Math.round(amount * 100);
      const originHeader = String(req.headers.origin || "").trim();
      const baseUrl =
        originHeader ||
        (process.env.CLIENT_URL || "http://localhost:3000")
          .split(",")[0]
          .trim()
          .replace(/\/+$/, "");

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: req.user.email,
        line_items: [
          {
            price_data: {
              currency: STRIPE_CURRENCY,
              product_data: {
                name: booking.serviceTitle || "FixMate Repair Service",
                description: booking.technicianName
                  ? `Technician: ${booking.technicianName}`
                  : "Verified FixMate repair service",
              },
              unit_amount: unitAmount,
            },
            quantity: 1,
          },
        ],
        metadata: {
          bookingId: String(booking._id),
          customerEmail: req.user.email,
          technicianEmail: String(booking.technicianEmail || "").toLowerCase(),
        },
        success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/payment/cancel`,
      });

      res.json({
        url: session.url,
        sessionId: session.id,
      });
    } catch (error) {
      console.error("POST /api/payments/create-checkout-session error:", error);
      res.status(500).json({
        message: error?.message || "Failed to create Stripe checkout session",
      });
    }
  },
);

// Customer: POST /api/payments/verify-session
app.post(
  "/api/payments/verify-session",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({
          message: "Stripe is not configured yet (missing STRIPE_SECRET_KEY)",
        });
      }

      const sessionId = String(req.body?.sessionId || "").trim();
      if (!sessionId) {
        return res
          .status(400)
          .json({ message: "Stripe checkout session ID is required" });
      }

      const checkoutSession =
        await stripe.checkout.sessions.retrieve(sessionId);

      if (checkoutSession.payment_status !== "paid") {
        return res.status(400).json({
          message: "Payment has not been completed yet",
        });
      }

      const bookingId = String(
        checkoutSession.metadata?.bookingId || "",
      ).trim();
      if (!bookingId || !ObjectId.isValid(bookingId)) {
        return res
          .status(400)
          .json({ message: "Missing booking reference in session" });
      }

      const { bookings, payments } = await getCollections();
      const booking = await bookings.findOne({ _id: new ObjectId(bookingId) });

      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      if (
        String(booking.customerEmail || "").toLowerCase() !== req.user.email
      ) {
        return res
          .status(403)
          .json({ message: "Forbidden: You can only verify your own payment" });
      }

      const paidAmount = Number(
        (checkoutSession.amount_total ?? 0) / 100 ||
          booking.finalAmount ||
          booking.basePrice ||
          0,
      );
      const transactionId =
        typeof checkoutSession.payment_intent === "string"
          ? checkoutSession.payment_intent
          : checkoutSession.id;
      const currency = String(
        checkoutSession.currency || STRIPE_CURRENCY,
      ).toUpperCase();

      // Avoid duplicate payment records on page refresh
      const existingPayment = await payments.findOne({
        stripeSessionId: checkoutSession.id,
      });

      const paidAt = existingPayment?.paidAt || booking.paidAt || new Date();

      if (!existingPayment) {
        await payments.insertOne({
          bookingId: String(booking._id),
          stripeSessionId: checkoutSession.id,
          transactionId,
          serviceTitle: booking.serviceTitle || "Repair Service",
          customerName: booking.customerName || req.user.name || "",
          customerEmail: req.user.email,
          technicianName: booking.technicianName || "",
          technicianEmail: String(booking.technicianEmail || "").toLowerCase(),
          amount: paidAmount,
          currency,
          status: "paid",
          paymentStatus: "paid",
          paidAt,
          createdAt: new Date(),
        });
      }

      await bookings.updateOne(
        { _id: booking._id },
        {
          $set: {
            paymentStatus: "paid",
            paidAmount,
            transactionId,
            paidAt,
          },
        },
      );

      res.json({
        message: "Payment verified successfully",
        bookingId: String(booking._id),
        serviceTitle: booking.serviceTitle || "Repair Service",
        technicianName: booking.technicianName || "Technician",
        transactionId,
        amount: paidAmount,
        currency,
        paidAt,
      });
    } catch (error) {
      console.error("POST /api/payments/verify-session error:", error);
      res.status(500).json({
        message: error?.message || "Failed to verify Stripe payment",
      });
    }
  },
);

// ==========================================
// TECHNICIAN BOOKING ROUTES
// ==========================================

// Technician: GET /api/bookings/technician?email=...
app.get(
  "/api/bookings/technician",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const requestedEmail = String(req.query.email || "")
        .trim()
        .toLowerCase();
      const targetEmail = requestedEmail || req.user.email;

      if (targetEmail !== req.user.email) {
        return res.status(403).json({
          message: "Forbidden: Cannot view another technician's bookings",
        });
      }

      const { bookings } = await getCollections();
      const list = await bookings
        .find({ technicianEmail: req.user.email })
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
  },
);

// Technician: PATCH /api/bookings/:id/status (strict pipeline + required finalAmount on completed)
app.patch(
  "/api/bookings/:id/status",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid booking ID" });
      }

      const nextStatus = String(req.body?.status || "")
        .trim()
        .toLowerCase();

      const allowedTargets = [
        "accepted",
        "rejected",
        "in-progress",
        "completed",
      ];
      if (!allowedTargets.includes(nextStatus)) {
        return res.status(400).json({ message: "Invalid status value" });
      }

      const { bookings } = await getCollections();
      const booking = await bookings.findOne({ _id: new ObjectId(id) });

      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      if (
        String(booking.technicianEmail || "").toLowerCase() !== req.user.email
      ) {
        return res
          .status(403)
          .json({ message: "Forbidden: You are not assigned to this booking" });
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

      if (nextStatus === "completed") {
        const parsedAmount = Number(req.body?.finalAmount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          return res.status(400).json({
            message:
              "A valid positive finalAmount is required to complete a booking",
          });
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
  },
);

// ==========================================
// ADMIN ROUTES
// ==========================================

// Admin: GET /api/admin/overview
app.get("/api/admin/overview", verifyToken, verifyAdmin, async (req, res) => {
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
    const categoryCounts = {};

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

      const cat = String(s.category || "Other").trim() || "Other";
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    let activeBookings = 0;
    let completedBookings = 0;
    let paidBookings = 0;
    let totalRevenue = 0;
    const bookingStatusCounts = {
      requested: 0,
      accepted: 0,
      "in-progress": 0,
      completed: 0,
      cancelled: 0,
      rejected: 0,
    };

    for (const b of allBookings) {
      const status = String(b.status || "requested").toLowerCase();
      if (bookingStatusCounts[status] !== undefined) {
        bookingStatusCounts[status] += 1;
      }

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

    const servicesByCategory = Object.entries(categoryCounts)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

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
      charts: {
        bookingStatusCounts,
        servicesByCategory,
      },
      recentPendingServices,
      recentBookings: allBookings.slice(0, 5),
    });
  } catch (error) {
    console.error("GET /api/admin/overview error:", error);
    res.status(500).json({ message: "Failed to load admin overview data" });
  }
});

// Admin: GET /api/admin/services?status=all|pending|approved|rejected&search=...
app.get("/api/admin/services", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const statusFilter = String(req.query.status || "all")
      .trim()
      .toLowerCase();
    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    const { services } = await getCollections();
    const allServices = await services
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    let approved = 0;
    let pending = 0;
    let rejected = 0;

    for (const s of allServices) {
      const st = String(
        s.approvalStatus || s.status || "pending",
      ).toLowerCase();
      if (st === "approved") approved += 1;
      else if (st === "rejected") rejected += 1;
      else pending += 1;
    }

    const filtered = allServices.filter((s) => {
      const st = String(
        s.approvalStatus || s.status || "pending",
      ).toLowerCase();

      const matchesStatus = statusFilter === "all" || st === statusFilter;
      if (!matchesStatus) return false;

      if (!search) return true;
      const haystack = [
        s.title,
        s.category,
        s.technicianName,
        s.technicianEmail,
        s.serviceArea,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(search);
    });

    res.json({
      services: filtered,
      stats: {
        total: allServices.length,
        approved,
        pending,
        rejected,
      },
    });
  } catch (error) {
    console.error("GET /api/admin/services error:", error);
    res.status(500).json({ message: "Failed to load admin services list" });
  }
});

// Admin: PATCH /api/admin/services/:id/approval
app.patch(
  "/api/admin/services/:id/approval",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid service ID" });
      }

      const approvalStatus = String(req.body?.approvalStatus || "")
        .trim()
        .toLowerCase();
      const rejectionReason = String(req.body?.rejectionReason || "").trim();

      if (!["approved", "rejected", "pending"].includes(approvalStatus)) {
        return res.status(400).json({
          message:
            'approvalStatus must be "approved", "rejected", or "pending"',
        });
      }

      const { services } = await getCollections();
      const existing = await services.findOne({ _id: new ObjectId(id) });

      if (!existing) {
        return res.status(404).json({ message: "Service not found" });
      }

      const updateFields = {
        approvalStatus,
        updatedAt: new Date(),
      };

      if (approvalStatus === "rejected" && rejectionReason) {
        updateFields.rejectionReason = rejectionReason;
      } else if (approvalStatus === "approved") {
        updateFields.rejectionReason = "";
      }

      const updated = await services.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updateFields },
        { returnDocument: "after" },
      );

      res.json({
        message: `Service ${approvalStatus} successfully`,
        service: updated,
      });
    } catch (error) {
      console.error("PATCH /api/admin/services/:id/approval error:", error);
      res
        .status(500)
        .json({ message: "Failed to update service approval status" });
    }
  },
);

// Admin: GET /api/admin/users?role=all|customer|technician|admin&search=...
app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const roleFilter = String(req.query.role || "all")
      .trim()
      .toLowerCase();
    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    const { users } = await getCollections();
    const allUsers = await users
      .find(
        {},
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
            updatedAt: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .toArray();

    let customers = 0;
    let technicians = 0;
    let admins = 0;

    for (const u of allUsers) {
      const r = String(u.role || "customer").toLowerCase();
      if (r === "technician") technicians += 1;
      else if (r === "admin") admins += 1;
      else customers += 1;
    }

    const filtered = allUsers.filter((u) => {
      const r = String(u.role || "customer").toLowerCase();
      const matchesRole = roleFilter === "all" || r === roleFilter;
      if (!matchesRole) return false;

      if (!search) return true;
      const haystack = [u.name, u.email, u.phone, u.area, r]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(search);
    });

    res.json({
      users: filtered,
      stats: {
        total: allUsers.length,
        customers,
        technicians,
        admins,
      },
    });
  } catch (error) {
    console.error("GET /api/admin/users error:", error);
    res.status(500).json({ message: "Failed to load users list" });
  }
});

// Admin: PATCH /api/admin/users/:id/role (cannot change own role)
app.patch(
  "/api/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const nextRole = String(req.body?.role || "")
        .trim()
        .toLowerCase();

      const allowedRoles = ["customer", "technician", "admin"];
      if (!allowedRoles.includes(nextRole)) {
        return res.status(400).json({
          message: 'Role must be "customer", "technician", or "admin"',
        });
      }

      const { users } = await getCollections();

      // Better Auth MongoDB adapter may store _id as ObjectId or string
      const idQuery = ObjectId.isValid(id)
        ? { $or: [{ _id: new ObjectId(id) }, { _id: id }, { id }] }
        : { $or: [{ _id: id }, { id }] };

      const targetUser = await users.findOne(idQuery);

      if (!targetUser) {
        return res.status(404).json({ message: "User not found" });
      }

      if (String(targetUser.email || "").toLowerCase() === req.user.email) {
        return res.status(400).json({
          message: "Admins cannot change their own role",
        });
      }

      const updated = await users.findOneAndUpdate(
        { _id: targetUser._id },
        {
          $set: {
            role: nextRole,
            updatedAt: new Date(),
          },
        },
        {
          returnDocument: "after",
          projection: {
            name: 1,
            email: 1,
            image: 1,
            role: 1,
            phone: 1,
            area: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      );

      res.json({
        message: `User role updated to ${nextRole}`,
        user: updated,
      });
    } catch (error) {
      console.error("PATCH /api/admin/users/:id/role error:", error);
      res.status(500).json({ message: "Failed to update user role" });
    }
  },
);

// Admin: GET /api/admin/bookings?status=all|requested|...&paymentStatus=all|paid|unpaid&search=...
app.get("/api/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const statusFilter = String(req.query.status || "all")
      .trim()
      .toLowerCase();
    const paymentFilter = String(req.query.paymentStatus || "all")
      .trim()
      .toLowerCase();
    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    const { bookings } = await getCollections();
    const allBookings = await bookings
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    let requested = 0;
    let accepted = 0;
    let inProgress = 0;
    let completed = 0;
    let cancelled = 0;
    let rejected = 0;
    let paid = 0;

    for (const b of allBookings) {
      const s = String(b.status || "requested").toLowerCase();
      if (s === "requested") requested += 1;
      else if (s === "accepted") accepted += 1;
      else if (s === "in-progress") inProgress += 1;
      else if (s === "completed") completed += 1;
      else if (s === "cancelled") cancelled += 1;
      else if (s === "rejected") rejected += 1;

      if (String(b.paymentStatus || "").toLowerCase() === "paid") {
        paid += 1;
      }
    }

    const filtered = allBookings.filter((b) => {
      const s = String(b.status || "requested").toLowerCase();
      const p = String(b.paymentStatus || "unpaid").toLowerCase();

      if (statusFilter !== "all" && s !== statusFilter) return false;
      if (paymentFilter !== "all" && p !== paymentFilter) return false;

      if (!search) return true;
      const haystack = [
        b.serviceTitle,
        b.category,
        b.customerName,
        b.customerEmail,
        b.technicianName,
        b.technicianEmail,
        b.address,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(search);
    });

    res.json({
      bookings: filtered,
      stats: {
        total: allBookings.length,
        requested,
        accepted,
        inProgress,
        completed,
        cancelled,
        rejected,
        paid,
        unpaid: allBookings.length - paid,
      },
    });
  } catch (error) {
    console.error("GET /api/admin/bookings error:", error);
    res.status(500).json({ message: "Failed to load platform bookings" });
  }
});

// Admin: GET /api/admin/payments?search=...
app.get("/api/admin/payments", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    const { payments } = await getCollections();
    const allPayments = await payments
      .find({})
      .sort({ paidAt: -1, createdAt: -1 })
      .toArray();

    let totalRevenue = 0;
    for (const p of allPayments) {
      totalRevenue += Number(p.amount || 0);
    }

    const filtered = allPayments.filter((p) => {
      if (!search) return true;
      const haystack = [
        p.transactionId,
        p.stripeSessionId,
        p.serviceTitle,
        p.customerName,
        p.customerEmail,
        p.technicianName,
        p.technicianEmail,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(search);
    });

    res.json({
      payments: filtered,
      stats: {
        totalTransactions: allPayments.length,
        totalRevenue,
        averageAmount:
          allPayments.length > 0 ? totalRevenue / allPayments.length : 0,
      },
    });
  } catch (error) {
    console.error("GET /api/admin/payments error:", error);
    res.status(500).json({ message: "Failed to load payment transactions" });
  }
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`FixMate server running on http://localhost:${port}`);
  });
}

export default app;
