import express from "express";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { Telegraf } from "telegraf";
import { Connection, PublicKey } from "@solana/web3.js";
import multer from "multer";
import winston from "winston";
import axios from "axios";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ storage: multer.memoryStorage() });

// Logger setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  logger.info(`Request: ${req.method} ${req.url}`, {
    userAgent: req.headers["user-agent"],
  });
  next();
});

// Validate environment variables
const firebaseConfig = {
  // Замените на вашу конфигурацию Firebase
  // apiKey: "YOUR_API_KEY",
  // authDomain: "YOUR_AUTH_DOMAIN",
  // projectId: "YOUR_PROJECT_ID",
  // storageBucket: "YOUR_STORAGE_BUCKET",
  // messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  // appId: "YOUR_APP_ID"
};
if (!firebaseConfig.projectId) {
  logger.error("FIREBASE_CONFIG invalid or missing", { firebaseConfig });
  process.exit(1);
}
if (!process.env.BOT_TOKEN) {
  logger.error("BOT_TOKEN not found");
  process.exit(1);
}

// Initialize Firebase
let firebaseApp;
try {
  firebaseApp = initializeApp(firebaseConfig);
  logger.info("Firebase initialized successfully");
} catch (error) {
  logger.error("Error initializing Firebase", {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
}
const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);

// Initialize Telegram Bot
const bot = new Telegraf(process.env.BOT_TOKEN); // Установите BOT_TOKEN в переменных окружения

// Initialize Solana
const connection = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
});
const recipient = new PublicKey("RECIPIENT_PUBLIC_KEY"); // Замените на ваш публичный ключ Solana
logger.info("Solana connection initialized");

// Get SOL/UAH exchange rate
const getSolPrice = async (uahPrice) => {
  try {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=uah",
      { timeout: 5000 },
    );
    const solPerUah = response.data.solana.uah;
    logger.info("Fetched SOL/UAH rate", { rate: solPerUah });
    return uahPrice / solPerUah;
  } catch (error) {
    logger.error("Error fetching SOL price", {
      message: error.message,
      stack: error.stack,
    });
    return uahPrice * 0.01; // Fallback
  }
};

// Telegram Bot Commands
bot.command("start", async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || "NoUsername";
  const chatId = ctx.chat.id;
  logger.info("Start command received", { userId, username });
  try {
    const usersRef = collection(db, "users");
    const userQuery = query(usersRef, where("userId", "==", userId));
    const userSnapshot = await getDocs(userQuery);
    const webAppUrl = "https://your-app-url/index.html"; // Замените на URL вашего приложения
    if (userSnapshot.empty) {
      await addDoc(usersRef, {
        userId,
        username,
        chatId,
        verified: true,
        verifiedAt: serverTimestamp(),
        subscribed: true,
        createdAt: serverTimestamp(),
      });
      logger.info("New user created", { userId, username });
    }
    await ctx.reply(
      "Вітаємо в TP TicketsPartners! Натисніть, щоб відкрити додаток:",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Відкрити додаток", web_app: { url: webAppUrl } }],
          ],
        },
      },
    );
  } catch (error) {
    logger.error("Error processing /start", {
      message: error.message,
      stack: error.stack,
    });
    await ctx.reply("Помилка. Спробуйте ще раз.");
  }
});

bot.command("subscribe", async (ctx) => {
  try {
    const usersRef = collection(db, "users");
    const userQuery = query(
      usersRef,
      where("userId", "==", ctx.from.id.toString()),
    );
    const userSnapshot = await getDocs(userQuery);
    if (userSnapshot.empty) {
      await addDoc(usersRef, {
        chatId: ctx.chat.id,
        userId: ctx.from.id.toString(),
        subscribed: true,
        createdAt: serverTimestamp(),
      });
    } else {
      const userDoc = userSnapshot.docs[0];
      await updateDoc(doc(db, "users", userDoc.id), {
        subscribed: true,
        updatedAt: serverTimestamp(),
      });
    }
    await ctx.reply("Ви підписались на сповіщення!");
    logger.info("User subscribed", {
      chatId: ctx.chat.id,
      userId: ctx.from.id,
    });
  } catch (error) {
    logger.error("Error subscribing", {
      message: error.message,
      stack: error.stack,
    });
    await ctx.reply("Помилка. Спробуйте ще раз.");
  }
});

bot.command("referral", (ctx) => {
  const userId = ctx.from.id;
  ctx.reply(
    `Ваше реферальне посилання: https://t.me/TPTicketsBot?start=ref_${userId}`,
  );
  logger.info("Referral link requested", { userId });
});

// API Endpoints
app.post("/api/event", upload.single("image"), async (req, res) => {
  logger.info("Received /api/event request", {
    body: req.body,
    file: req.file
      ? {
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
        }
      : "No file",
  });
  const { name, date, place, price, description, category, promocodes } =
    req.body;
  if (!name || !date || !place || !price || !category) {
    logger.error("Missing required fields", {
      name,
      date,
      place,
      price,
      category,
    });
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields" });
  }
  try {
    // Validate date
    const eventDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (eventDate < today) {
      logger.error("Event date is in the past", { date });
      return res
        .status(400)
        .json({ success: false, error: "Event date cannot be in the past" });
    }
    // Upload image to Firebase Storage
    let imageUrl = "";
    if (req.file && req.file.buffer && req.file.buffer.length > 0) {
      const allowedTypes = ["image/jpeg", "image/png", "image/gif"];
      if (!allowedTypes.includes(req.file.mimetype)) {
        logger.error("Invalid image type", { mimetype: req.file.mimetype });
        return res.status(400).json({
          success: false,
          error: "Only JPEG, PNG, or GIF images are allowed",
        });
      }
      const storageRef = ref(
        storage,
        `events/${Date.now()}_${req.file.originalname}`,
      );
      const snapshot = await uploadBytes(storageRef, req.file.buffer);
      imageUrl = await getDownloadURL(snapshot.ref);
      logger.info("Image uploaded to Firebase Storage", { imageUrl });
    }
    let parsedPromocodes = [];
    if (promocodes) {
      try {
        parsedPromocodes = JSON.parse(promocodes);
        logger.info("Parsed promocodes", { parsedPromocodes });
      } catch (parseError) {
        logger.error("Error parsing promocodes", {
          message: parseError.message,
        });
        return res
          .status(400)
          .json({ success: false, error: "Invalid promocodes format" });
      }
    }
    const eventData = {
      name,
      date,
      place,
      price: parseInt(price),
      description: description || "",
      category: category || "",
      promocodes: parsedPromocodes,
      imageUrl,
      createdAt: serverTimestamp(),
    };
    logger.info("Saving event to Firestore", { eventData });
    const eventRef = collection(db, "events");
    const eventDoc = await addDoc(eventRef, eventData);
    logger.info("Event saved successfully", { eventId: eventDoc.id });
    // Notify subscribed users
    try {
      const usersRef = collection(db, "users");
      const usersSnapshot = await getDocs(usersRef);
      usersSnapshot.forEach(async (userDoc) => {
        if (userDoc.data().subscribed) {
          try {
            await bot.telegram.sendMessage(
              userDoc.data().chatId,
              `Новий захід "${name}" створено!`,
            );
            logger.info("Notification sent", { userId: userDoc.data().userId });
          } catch (sendError) {
            logger.error("Error sending notification", {
              message: sendError.message,
              stack: sendError.stack,
            });
          }
        }
      });
    } catch (notificationError) {
      logger.error("Error sending notifications", {
        message: notificationError.message,
        stack: notificationError.stack,
      });
    }
    res.json({
      success: true,
      message: "Захід створено",
      eventId: eventDoc.id,
    });
  } catch (error) {
    logger.error("Error in /api/event", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      error: `Failed to create event: ${error.message}`,
    });
  }
});

app.get("/api/events", async (req, res) => {
  logger.info("Received /api/events request", {
    userAgent: req.headers["user-agent"],
  });
  try {
    const eventsRef = collection(db, "events");
    const querySnapshot = await getDocs(eventsRef);
    const events = [];
    querySnapshot.forEach((doc) => {
      events.push({ id: doc.id, ...doc.data() });
      logger.debug("Fetched event", { id: doc.id, name: doc.data().name });
    });
    logger.info("Events fetched", { count: events.length });
    res.json(events);
  } catch (error) {
    logger.error("Error fetching events", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      error: `Failed to fetch events: ${error.message}`,
    });
  }
});

app.get("/api/tickets/:userId", async (req, res) => {
  const { userId } = req.params;
  logger.info("Received /api/tickets request", { userId });
  try {
    const ticketsRef = collection(db, "tickets");
    const ticketQuery = query(ticketsRef, where("userId", "==", userId));
    const querySnapshot = await getDocs(ticketQuery);
    const tickets = [];
    querySnapshot.forEach((doc) => {
      tickets.push({ id: doc.id, ...doc.data() });
    });
    logger.info("Tickets fetched", { userId, count: tickets.length });
    res.json(tickets);
  } catch (error) {
    logger.error("Error fetching tickets", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      error: `Failed to fetch tickets: ${error.message}`,
    });
  }
});

app.post("/api/validate-promo", async (req, res) => {
  const { promoCode, eventId } = req.body;
  logger.info("Received /api/validate-promo request", { promoCode, eventId });
  if (!promoCode || !eventId) {
    logger.error("Missing promo code or eventId", { promoCode, eventId });
    return res
      .status(400)
      .json({ success: false, error: "Missing promo code or eventId" });
  }
  try {
    const eventRef = doc(db, "events", eventId);
    const eventSnap = await getDoc(eventRef);
    if (!eventSnap.exists()) {
      logger.error("Event not found", { eventId });
      return res.status(404).json({ success: false, error: "Event not found" });
    }
    const event = eventSnap.data();
    const normalizedPromoCode = promoCode.trim().toLowerCase();
    const promo = event.promocodes?.find(
      (p) => p.code.trim().toLowerCase() === normalizedPromoCode,
    );
    if (!promo) {
      logger.error("Invalid promo code", {
        promoCode,
        available: event.promocodes,
      });
      return res
        .status(400)
        .json({ success: false, error: "Invalid promo code" });
    }
    const ticketsRef = collection(db, "tickets");
    const ticketsQuery = query(
      ticketsRef,
      where("eventId", "==", eventId),
      where("promoCode", "==", promoCode),
    );
    const ticketsSnapshot = await getDocs(ticketsQuery);
    const usageCount = ticketsSnapshot.size;
    if (usageCount >= promo.usageLimit) {
      logger.error("Promo code usage limit reached", { promoCode });
      return res
        .status(400)
        .json({ success: false, error: "Promo code usage limit reached" });
    }
    res.json({ valid: true, discount: promo.discount * 100 });
  } catch (error) {
    logger.error("Error validating promo", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      error: `Failed to validate promo: ${error.message}`,
    });
  }
});

app.post("/api/stub-purchase", async (req, res) => {
  const { eventId, userId, finalPrice, promoCode } = req.body;
  logger.info("Received /api/stub-purchase request", {
    eventId,
    userId,
    finalPrice,
    promoCode,
  });
  if (!eventId || !userId) {
    logger.error("Missing required fields", { eventId, userId });
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields" });
  }
  try {
    const eventRef = doc(db, "events", eventId);
    const eventSnap = await getDoc(eventRef);
    if (!eventSnap.exists()) {
      logger.error("Event not found", { eventId });
      return res.status(404).json({ success: false, error: "Event not found" });
    }
    const event = eventSnap.data();
    let discount = 0;
    if (promoCode) {
      const normalizedPromoCode = promoCode.trim().toLowerCase();
      const promo = event.promocodes?.find(
        (p) => p.code.trim().toLowerCase() === normalizedPromoCode,
      );
      if (!promo) {
        logger.error("Invalid promo code", {
          promoCode,
          available: event.promocodes,
        });
        return res
          .status(400)
          .json({ success: false, error: "Invalid promo code" });
      }
      if (promo.discount <= 0 || promo.discount > 1) {
        logger.error("Invalid promo discount value", {
          discount: promo.discount,
        });
        return res
          .status(400)
          .json({ success: false, error: "Invalid promo discount value" });
      }
      const ticketsRef = collection(db, "tickets");
      const ticketsQuery = query(
        ticketsRef,
        where("eventId", "==", eventId),
        where("promoCode", "==", promoCode),
      );
      const ticketsSnapshot = await getDocs(ticketsQuery);
      const usageCount = ticketsSnapshot.size;
      if (usageCount >= promo.usageLimit) {
        logger.error("Promo code usage limit reached", { promoCode });
        return res
          .status(400)
          .json({ success: false, error: "Promo code usage limit reached" });
      }
      discount = promo.discount;
      const updatedPromocodes = event.promocodes.map((p) =>
        p.code.trim().toLowerCase() === normalizedPromoCode
          ? { ...p, usedCount: (p.usedCount || 0) + 1 }
          : p,
      );
      await updateDoc(eventRef, { promocodes: updatedPromocodes });
      logger.info("Updated promo code usage", { promoCode, updatedPromocodes });
    }
    const originalPrice = event.price || 0;
    const expectedFinalPrice = originalPrice * (1 - discount);
    if (Math.abs(finalPrice - expectedFinalPrice) > 0.01) {
      logger.error("Incorrect final price", {
        finalPrice,
        expectedFinalPrice,
      });
      return res
        .status(400)
        .json({ success: false, error: "Incorrect final price with promo" });
    }
    const ticketId = `TICKET_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const ticketData = {
      eventId,
      userId,
      paymentMethod: "TestPayment",
      finalPrice,
      createdAt: serverTimestamp(),
      ticketId,
      eventName: event.name,
      eventDate: event.date,
      eventPlace: event.place,
      imageUrl: event.imageUrl || "",
      promoCode: promoCode || "",
    };
    logger.info("Saving ticket to Firestore", { ticketData });
    const ticketRef = collection(db, "tickets");
    const ticketDoc = await addDoc(ticketRef, ticketData);
    logger.info("Ticket saved successfully", {
      ticketId: ticketDoc.id,
      ticketCode: ticketId,
    });
    // Notify user
    const usersRef = collection(db, "users");
    const userQuery = query(usersRef, where("userId", "==", userId));
    const usersSnapshot = await getDocs(userQuery);
    const user = usersSnapshot.docs[0];
    if (user && event) {
      try {
        await bot.telegram.sendMessage(
          user.data().chatId,
          `Ви купили квиток на "${event.name}"! Код квитка: ${ticketId}`,
        );
        logger.info("Ticket notification sent", { userId });
      } catch (sendError) {
        logger.error("Error sending ticket notification", {
          message: sendError.message,
          stack: sendError.stack,
        });
      }
    }
    res.json({ success: true, ticketId: ticketDoc.id, ticketCode: ticketId });
  } catch (error) {
    logger.error("Error processing stub purchase", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      error: `Stub purchase failed: ${error.message}`,
    });
  }
});

app.post("/api/solana-pay", async (req, res) => {
  const {
    reference,
    eventId,
    userId,
    finalPrice,
    eventName,
    eventDate,
    eventPlace,
    imageUrl,
  } = req.body;
  logger.info("Received /api/solana-pay request", {
    reference,
    eventId,
    userId,
    finalPrice,
  });
  if (!reference || !eventId || !userId || finalPrice == null) {
    logger.error("Missing required fields", {
      reference,
      eventId,
      userId,
      finalPrice,
    });
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields" });
  }
  try {
    const referencePublicKey = new PublicKey(reference);
    const signatures = await connection.getSignaturesForAddress(
      referencePublicKey,
      { limit: 1 },
    );
    if (signatures.length === 0) {
      logger.info("Transaction not found", { reference });
      return res
        .status(400)
        .json({ success: false, error: "Transaction not found" });
    }
    const signature = signatures[0].signature;
    const transaction = await connection.getParsedTransaction(signature, {
      commitment: "confirmed",
    });
    if (!transaction) {
      logger.error("Transaction not confirmed", { signature });
      return res
        .status(400)
        .json({ success: false, error: "Transaction not confirmed" });
    }
    const transferInstruction =
      transaction.transaction.message.instructions.find(
        (inst) =>
          inst.programId.toBase58() === "11111111111111111111111111111111",
      );
    if (!transferInstruction) {
      logger.error("No transfer instruction found", { signature });
      return res.status(400).json({
        success: false,
        error: "Invalid transaction: no transfer instruction",
      });
    }
    const parsedInfo = transferInstruction.parsed.info;
    if (parsedInfo.destination !== recipient.toBase58()) {
      logger.error("Invalid recipient", {
        actual: parsedInfo.destination,
        expected: recipient.toBase58(),
      });
      return res
        .status(400)
        .json({ success: false, error: "Invalid recipient" });
    }
    const solAmount = await getSolPrice(finalPrice);
    const expectedLamports = Math.round(solAmount * 1_000_000_000);
    if (Math.abs(parsedInfo.lamports - expectedLamports) > 1000) {
      logger.error("Invalid amount", {
        actual: parsedInfo.lamports,
        expected: expectedLamports,
      });
      return res
        .status(400)
        .json({ success: false, error: "Invalid transaction amount" });
    }
    const eventRef = doc(db, "events", eventId);
    const eventSnap = await getDoc(eventRef);
    if (!eventSnap.exists()) {
      logger.error("Event not found", { eventId });
      return res.status(404).json({ success: false, error: "Event not found" });
    }
    const ticketId = `TICKET_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const ticketData = {
      eventId,
      userId,
      paymentMethod: "SolanaPay",
      finalPrice,
      createdAt: serverTimestamp(),
      ticketId,
      eventName,
      eventDate,
      eventPlace,
      imageUrl: imageUrl || "",
      transactionSignature: signature,
    };
    logger.info("Saving Solana Pay ticket to Firestore", { ticketData });
    const ticketRef = collection(db, "tickets");
    const ticketDoc = await addDoc(ticketRef, ticketData);
    logger.info("Solana Pay ticket saved successfully", {
      ticketId: ticketDoc.id,
      ticketCode: ticketId,
    });
    const usersRef = collection(db, "users");
    const userQuery = query(usersRef, where("userId", "==", userId));
    const usersSnapshot = await getDocs(userQuery);
    const user = usersSnapshot.docs[0];
    if (user) {
      try {
        await bot.telegram.sendMessage(
          user.data().chatId,
          `Ви купили квиток на "${eventName}" через Solana Pay! Код квитка: ${ticketId}`,
        );
        logger.info("Solana Pay ticket notification sent", { userId });
      } catch (sendError) {
        logger.error("Error sending Solana Pay ticket notification", {
          message: sendError.message,
          stack: sendError.stack,
        });
      }
    }
    res.json({ success: true, ticketId: ticketDoc.id, ticketCode: ticketId });
  } catch (error) {
    logger.error("Error processing Solana Pay", {
      message: error.message,
      stack: error.stack,
    });
    res
      .status(500)
      .json({ success: false, error: `Solana Pay failed: ${error.message}` });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
  bot
    .launch()
    .then(() => logger.info("Telegram bot launched"))
    .catch((err) =>
      logger.error("Failed to launch bot", {
        message: err.message,
        stack: err.stack,
      }),
    );
});

// Keep-alive for hosting platforms
setInterval(() => {
  logger.info("Keep-alive ping");
  axios
    .get("https://your-app-url") // Замените на URL вашего приложения
    .catch((err) =>
      logger.error("Keep-alive ping failed", { message: err.message }),
    );
}, 300000); // Every 5 minutes

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received. Shutting down gracefully...");
  bot.stop("SIGTERM");
  process.exit(0);
});
