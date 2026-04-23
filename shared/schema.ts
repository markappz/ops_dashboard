import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, index, jsonb, integer, decimal, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Session storage table (Cognito Auth)
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User storage table (Cognito OAuth)
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  passwordHash: varchar("password_hash"), // For email/password auth
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  phone: varchar("phone"),
  dateOfBirth: varchar("date_of_birth"),
  sex: varchar("sex"),
  profileImageUrl: varchar("profile_image_url"),
  // Gamification fields
  xp: integer("xp").default(0),
  level: integer("level").default(1),
  currentStreak: integer("current_streak").default(0),
  longestStreak: integer("longest_streak").default(0),
  lastActiveDate: timestamp("last_active_date"),
  lastStreakDate: varchar("last_streak_date"), // YYYY-MM-DD in user's timezone when streak was last updated
  // User timezone for daily resets
  timezone: varchar("timezone").default("America/New_York"),
  // Verified biological age from tests like TruAge, GlycanAge, DNA methylation
  verifiedBioAge: integer("verified_bio_age"),
  // Subscription fields
  subscriptionTier: varchar("subscription_tier").default("free"), // 'free', 'essentials', 'complete'
  subscriptionStatus: varchar("subscription_status").default("active"), // 'active', 'canceled', 'past_due'
  subscriptionPeriod: varchar("subscription_period"), // 'monthly', 'annual'
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  aiAdvisorUsageCount: integer("ai_advisor_usage_count").default(0),
  aiAdvisorUsageResetAt: timestamp("ai_advisor_usage_reset_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;

// Consultations table
export const consultations = pgTable("consultations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  dateOfBirth: text("date_of_birth").notNull(),
  primaryConcerns: text("primary_concerns").array().notNull(),
  additionalInfo: text("additional_info"),
  preferredDate: text("preferred_date").notNull(),
  preferredTime: text("preferred_time").notNull(),
  agreedToTerms: boolean("agreed_to_terms").notNull().default(false),
  status: varchar("status").notNull().default("pending"),
  paymentStatus: varchar("payment_status").default("unpaid"),
  paymentIntentId: varchar("payment_intent_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertConsultationSchema = createInsertSchema(consultations).omit({
  id: true,
  createdAt: true,
  paymentIntentId: true,
});

export type InsertConsultation = z.infer<typeof insertConsultationSchema>;
export type Consultation = typeof consultations.$inferSelect;

// Biomarker results table
export const biomarkerResults = pgTable("biomarker_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  biomarkerName: varchar("biomarker_name").notNull(),
  value: decimal("value").notNull(),
  unit: varchar("unit").notNull(),
  normalRangeLow: decimal("normal_range_low"),
  normalRangeHigh: decimal("normal_range_high"),
  status: varchar("status").notNull().default("normal"),
  testDate: timestamp("test_date").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertBiomarkerResultSchema = createInsertSchema(biomarkerResults).omit({
  id: true,
  createdAt: true,
});

export type InsertBiomarkerResult = z.infer<typeof insertBiomarkerResultSchema>;
export type BiomarkerResult = typeof biomarkerResults.$inferSelect;

// Treatment protocols table
export const treatmentProtocols = pgTable("treatment_protocols", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  name: varchar("name").notNull(),
  category: varchar("category").notNull(),
  description: text("description"),
  medications: jsonb("medications").$type<Array<{name: string; dosage: string; frequency: string}>>().default([]),
  supplements: jsonb("supplements").$type<Array<{name: string; dosage: string; frequency: string}>>().default([]),
  lifestyleRecommendations: text("lifestyle_recommendations").array().default([]),
  status: varchar("status").notNull().default("active"),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTreatmentProtocolSchema = createInsertSchema(treatmentProtocols).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTreatmentProtocol = z.infer<typeof insertTreatmentProtocolSchema>;
export type TreatmentProtocol = typeof treatmentProtocols.$inferSelect;

// Messages table for patient-provider communication
export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  consultationId: varchar("consultation_id").references(() => consultations.id),
  senderId: varchar("sender_id").notNull().references(() => users.id),
  receiverId: varchar("receiver_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
  isRead: true,
});

export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;

// Contact inquiries table
export const contactInquiries = pgTable("contact_inquiries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertContactInquirySchema = createInsertSchema(contactInquiries).omit({
  id: true,
  createdAt: true,
});

export type InsertContactInquiry = z.infer<typeof insertContactInquirySchema>;
export type ContactInquiry = typeof contactInquiries.$inferSelect;

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  consultations: many(consultations),
  biomarkerResults: many(biomarkerResults),
  treatmentProtocols: many(treatmentProtocols),
  sentMessages: many(messages, { relationName: "sender" }),
  receivedMessages: many(messages, { relationName: "receiver" }),
}));

export const consultationsRelations = relations(consultations, ({ one, many }) => ({
  user: one(users, {
    fields: [consultations.userId],
    references: [users.id],
  }),
  messages: many(messages),
}));

export const biomarkerResultsRelations = relations(biomarkerResults, ({ one }) => ({
  user: one(users, {
    fields: [biomarkerResults.userId],
    references: [users.id],
  }),
}));

export const treatmentProtocolsRelations = relations(treatmentProtocols, ({ one }) => ({
  user: one(users, {
    fields: [treatmentProtocols.userId],
    references: [users.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  consultation: one(consultations, {
    fields: [messages.consultationId],
    references: [consultations.id],
  }),
  sender: one(users, {
    fields: [messages.senderId],
    references: [users.id],
    relationName: "sender",
  }),
  receiver: one(users, {
    fields: [messages.receiverId],
    references: [users.id],
    relationName: "receiver",
  }),
}));

// Static data
export const treatmentCategories = [
  {
    id: "weight-loss",
    title: "Weight Loss",
    description: "GLP-1 medications like Semaglutide & Tirzepatide. Lose 15-20% of your body weight.",
    icon: "TrendingDown",
    image: "weight-loss",
  },
  {
    id: "hormone-optimization",
    title: "Hormone Therapy",
    description: "Testosterone, estrogen, and thyroid optimization. Feel like yourself again.",
    icon: "Zap",
    image: "hormone-therapy",
  },
  {
    id: "sexual-health",
    title: "Sexual Health",
    description: "ED medications, libido support, and performance solutions. Discreet delivery.",
    icon: "Heart",
    image: "sexual-health",
  },
  {
    id: "hair-loss",
    title: "Hair Restoration",
    description: "Finasteride, Minoxidil, and advanced hair loss treatments. Stop loss, regrow hair.",
    icon: "Sparkles",
    image: "hair-restoration",
  },
  {
    id: "peptides",
    title: "Peptides & Performance",
    description: "BPC-157, Sermorelin, and cutting-edge peptides for recovery and performance.",
    icon: "Battery",
    image: "peptides",
  },
  {
    id: "skin-care",
    title: "Prescription Skincare",
    description: "Tretinoin, hydroquinone, and custom formulas for anti-aging and clear skin.",
    icon: "Sun",
    image: "skincare",
  },
  {
    id: "longevity",
    title: "Longevity & Wellness",
    description: "NAD+, Metformin, Rapamycin, and protocols for healthy aging.",
    icon: "Infinity",
    image: "longevity",
  },
] as const;

export type TreatmentCategory = typeof treatmentCategories[number];

export const biomarkers = [
  "Testosterone",
  "Cortisol",
  "Thyroid (T3/T4)",
  "Vitamin D",
  "Estradiol",
  "DHEA-S",
  "Insulin",
  "HbA1c",
  "Cholesterol",
  "CRP",
  "Homocysteine",
  "Liver Enzymes",
  "Kidney Function",
  "Iron Panel",
  "B12",
  "Magnesium",
] as const;

export type Biomarker = typeof biomarkers[number];

export const concernOptions = [
  "Low energy / fatigue",
  "Weight management",
  "Hormone imbalance",
  "Sexual health",
  "Hair loss",
  "Skin concerns",
  "Mood / mental clarity",
  "Sleep issues",
  "Muscle loss / weakness",
  "Aging concerns",
] as const;

export type ConcernOption = typeof concernOptions[number];

// Quiz system tables
export const quizzes = pgTable("quizzes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  categoryId: varchar("category_id").notNull(),
  title: varchar("title").notNull(),
  description: text("description"),
  introHeadline: text("intro_headline"),
  introSubhead: text("intro_subhead"),
  introCta: varchar("intro_cta"),
  resultsHeadline: text("results_headline"),
  resultsBody: text("results_body"),
  resultsCta: varchar("results_cta"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export type Quiz = typeof quizzes.$inferSelect;

export const quizQuestions = pgTable("quiz_questions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  quizId: varchar("quiz_id").notNull().references(() => quizzes.id),
  questionText: text("question_text").notNull(),
  questionType: varchar("question_type").notNull().default("single"), // single, multiple, text
  order: integer("order").notNull().default(0),
  isRequired: boolean("is_required").notNull().default(true),
  helpText: text("help_text"),
});

export type QuizQuestion = typeof quizQuestions.$inferSelect;

export const quizOptions = pgTable("quiz_options", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  questionId: varchar("question_id").notNull().references(() => quizQuestions.id),
  optionText: text("option_text").notNull(),
  order: integer("order").notNull().default(0),
});

export type QuizOption = typeof quizOptions.$inferSelect;

export const quizResponses = pgTable("quiz_responses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  quizId: varchar("quiz_id").notNull().references(() => quizzes.id),
  userId: varchar("user_id").references(() => users.id),
  sessionId: varchar("session_id"),
  answers: jsonb("answers").$type<Record<string, string | string[]>>().notNull(),
  metadata: jsonb("metadata").$type<{ productId?: string; variantId?: string }>(),
  completed: boolean("completed").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertQuizResponseSchema = createInsertSchema(quizResponses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertQuizResponse = z.infer<typeof insertQuizResponseSchema>;
export type QuizResponse = typeof quizResponses.$inferSelect;

// Quiz relations
export const quizzesRelations = relations(quizzes, ({ many }) => ({
  questions: many(quizQuestions),
  responses: many(quizResponses),
}));

export const quizQuestionsRelations = relations(quizQuestions, ({ one, many }) => ({
  quiz: one(quizzes, {
    fields: [quizQuestions.quizId],
    references: [quizzes.id],
  }),
  options: many(quizOptions),
}));

export const quizOptionsRelations = relations(quizOptions, ({ one }) => ({
  question: one(quizQuestions, {
    fields: [quizOptions.questionId],
    references: [quizQuestions.id],
  }),
}));

export const quizResponsesRelations = relations(quizResponses, ({ one }) => ({
  quiz: one(quizzes, {
    fields: [quizResponses.quizId],
    references: [quizzes.id],
  }),
  user: one(users, {
    fields: [quizResponses.userId],
    references: [users.id],
  }),
}));

// ============================================================
// PHASE 3: AI CHAT SYSTEM TABLES
// ============================================================

// Service type enum for clinical intake
export const serviceTypes = ["TRT", "GLP1", "PEPTIDES", "SEXUAL_HEALTH", "LONGEVITY", "HAIR_LOSS", "SKIN_CARE", "MENTAL_HEALTH"] as const;
export type ServiceType = typeof serviceTypes[number];

// Chat session status enum - expanded for structured intake flow
export const chatSessionStatuses = [
  "NOT_STARTED",      // Session created but intake not begun
  "IN_PROGRESS",      // User actively completing intake questions
  "PENDING_REVIEW",   // Submitted, awaiting provider review
  "PROVIDER_QUESTION",// Provider needs more info from user
  "VIDEO_SCHEDULED",  // Video consultation scheduled
  "APPROVED",         // Provider approved treatment
  "DENIED",           // Provider denied (with reason)
  "ORDERED",          // User completed order
  "PROCESSING",       // Order being processed/shipped
  "SHIPPED",          // Medication shipped
  "ACTIVE_TREATMENT", // Ongoing treatment
  // Legacy statuses for backward compatibility
  "ACTIVE",           // Maps to IN_PROGRESS
  "WAITING_LABS",     // Maps to PENDING_REVIEW
  "COMPLETED",        // Maps to APPROVED or ACTIVE_TREATMENT
  "ARCHIVED",         // Maps to DENIED or completed sessions
] as const;
export type ChatSessionStatus = typeof chatSessionStatuses[number];

// Intake stage enum for structured question flow
export const intakeStages = ["QUALIFIER", "MEDICAL_HISTORY", "TREATMENT_MATCHING", "CONFIRMATION", "SUBMITTED"] as const;
export type IntakeStage = typeof intakeStages[number];

// Chat message role enum
export const chatMessageRoles = ["USER", "AI", "PROVIDER", "SYSTEM"] as const;
export type ChatMessageRole = typeof chatMessageRoles[number];

// Structured intake answer type
export type IntakeAnswer = {
  questionId: string;
  questionText: string;
  answerValue: string | string[] | number | boolean;
  answerDisplay: string; // Human-readable answer
  answeredAt: string;
};

// Treatment recommendation type
export type TreatmentRecommendation = {
  primaryTreatment: {
    name: string;
    description: string;
    reasoning: string;
    priceFrom: number;
  };
  alternativeTreatment?: {
    name: string;
    description: string;
    priceFrom: number;
  };
  requiresVideoConsult?: boolean;
  videoConsultReason?: string;
};

// Chat sessions - clinical intake conversations
export const chatSessions = pgTable("chat_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  visibleId: varchar("visible_id").notNull().unique(), // e.g., "HUMN-TRT-4521"
  userId: varchar("user_id").notNull().references(() => users.id),
  quizResponseId: varchar("quiz_response_id").references(() => quizResponses.id),
  serviceType: varchar("service_type").notNull(), // TRT, GLP1, etc.
  status: varchar("status").notNull().default("IN_PROGRESS"),
  
  // Structured intake progress tracking
  intakeStage: varchar("intake_stage").default("QUALIFIER"), // Current stage in intake flow
  currentQuestionIndex: integer("current_question_index").default(0),
  totalQuestions: integer("total_questions").default(12),
  intakeAnswers: jsonb("intake_answers").$type<IntakeAnswer[]>().default([]),
  intakeStartedAt: timestamp("intake_started_at"),
  intakeCompletedAt: timestamp("intake_completed_at"),
  
  // Treatment recommendation (generated after intake)
  treatmentRecommendation: jsonb("treatment_recommendation").$type<TreatmentRecommendation>(),
  
  // Provider review fields
  providerNotes: text("provider_notes"),
  denialReason: text("denial_reason"),
  providerReviewedAt: timestamp("provider_reviewed_at"),
  
  aiSummary: text("ai_summary"), // AI-generated clinical summary
  extractedData: jsonb("extracted_data").$type<{
    symptoms?: Array<{ name: string; duration: string; severity: string }>;
    medicalHistory?: Array<{ condition: string; status: string }>;
    medications?: Array<{ name: string; dosage: string; frequency: string }>;
    allergies?: string[];
    contraindications?: Array<{ condition: string; severity: string }>;
    lifestyle?: {
      exerciseFrequency?: string;
      alcoholUse?: string;
      tobaccoUse?: string;
      sleepQuality?: string;
    };
    labsStatus?: string;
    goals?: string[];
  }>(),
  readyForProvider: boolean("ready_for_provider").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertChatSessionSchema = createInsertSchema(chatSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChatSession = z.infer<typeof insertChatSessionSchema>;
export type ChatSession = typeof chatSessions.$inferSelect;

// Chat messages - individual messages in a session
export const chatMessages = pgTable("chat_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
  role: varchar("role").notNull(), // USER, AI, PROVIDER, SYSTEM
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<{
    extractedData?: Record<string, unknown>;
    tokens?: number;
    model?: string;
  }>(),
  isRead: boolean("is_read").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({
  id: true,
  createdAt: true,
  isRead: true,
});

export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;

// Activity events - for dashboard activity feed
export const activityEvents = pgTable("activity_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  type: varchar("type").notNull(), // chat_started, labs_uploaded, prescription_shipped, etc.
  title: text("title").notNull(),
  description: text("description"),
  link: varchar("link"), // Optional link to related page
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  isRead: boolean("is_read").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertActivityEventSchema = createInsertSchema(activityEvents).omit({
  id: true,
  createdAt: true,
  isRead: true,
});

export type InsertActivityEvent = z.infer<typeof insertActivityEventSchema>;
export type ActivityEvent = typeof activityEvents.$inferSelect;

// XP Transactions - track XP earned for gamification
export const xpTransactions = pgTable("xp_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(),
  action: varchar("action", { length: 50 }).notNull(), // 'lab_upload', 'consultation_complete', 'treatment_start', etc.
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertXpTransactionSchema = createInsertSchema(xpTransactions).omit({
  id: true,
  createdAt: true,
});

export type InsertXpTransaction = z.infer<typeof insertXpTransactionSchema>;
export type XpTransaction = typeof xpTransactions.$inferSelect;

// ============================================================
// PHASE 4: LAB SYSTEM TABLES
// ============================================================

// Lab upload status enum
export const labUploadStatuses = ["PENDING", "PROCESSING", "PARSED", "GRADED", "ERROR"] as const;
export type LabUploadStatus = typeof labUploadStatuses[number];

// Lab grade enum
export const labGrades = ["A", "B", "C", "D"] as const;
export type LabGrade = typeof labGrades[number];

// Lab uploads - uploaded lab files
export const labUploads = pgTable("lab_uploads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  visibleId: varchar("visible_id").notNull().unique(), // e.g., "LAB-4521"
  userId: varchar("user_id").notNull().references(() => users.id),
  chatSessionId: varchar("chat_session_id").references(() => chatSessions.id),
  originalFilename: varchar("original_filename").notNull(),
  fileUrl: varchar("file_url").notNull(),
  fileType: varchar("file_type").notNull(), // PDF, PNG, JPG
  fileSize: integer("file_size").notNull(), // bytes
  status: varchar("status").notNull().default("PENDING"),
  labDate: timestamp("lab_date"),
  labProvider: varchar("lab_provider"), // Quest, LabCorp, etc.
  rawText: text("raw_text"), // Extracted text from PDF/OCR
  parsedData: jsonb("parsed_data").$type<{
    values?: Array<{
      name: string;
      value: number | string;
      unit: string;
      referenceRange?: string;
      flag?: string;
    }>;
  }>(),
  grade: varchar("grade"), // A, B, C, D
  gradeDetails: jsonb("grade_details").$type<{
    eligible?: boolean;
    flags?: Array<{ marker: string; status: string; value: string; action: string }>;
    summary?: string;
    recommendedProtocol?: string;
  }>(),
  uploadedAt: timestamp("uploaded_at").defaultNow(),
  processedAt: timestamp("processed_at"),
  gradedAt: timestamp("graded_at"),
});

export const insertLabUploadSchema = createInsertSchema(labUploads).omit({
  id: true,
  uploadedAt: true,
  processedAt: true,
  gradedAt: true,
});

export type InsertLabUpload = z.infer<typeof insertLabUploadSchema>;
export type LabUpload = typeof labUploads.$inferSelect;

// ============================================================
// LAB ANALYSIS SYSTEM - Manual Entry + AI Analysis
// ============================================================

// Lab result status enum
export const labResultStatuses = ["pending", "analyzed", "error"] as const;
export type LabResultStatus = typeof labResultStatuses[number];

// Lab results - main record for a set of biomarker entries
export const labResults = pgTable("lab_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  name: varchar("name").default("Lab Results"),
  labDate: timestamp("lab_date"),
  labProvider: varchar("lab_provider"), // Quest, LabCorp, HUMN, other
  source: varchar("source").default("manual"), // manual, upload, integration
  status: varchar("status").default("pending"), // pending, analyzed, error
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertLabResultSchema = createInsertSchema(labResults).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLabResult = z.infer<typeof insertLabResultSchema>;
export type LabResult = typeof labResults.$inferSelect;

// Biomarker entry status enum
export const biomarkerStatusTypes = ["optimal", "suboptimal-low", "suboptimal-high", "low", "high", "critical", "unknown"] as const;
export type BiomarkerStatusType = typeof biomarkerStatusTypes[number];

// Biomarker entries - individual biomarker values within a lab result
export const biomarkerEntries = pgTable("biomarker_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  labResultId: varchar("lab_result_id").notNull().references(() => labResults.id, { onDelete: "cascade" }),
  biomarkerId: varchar("biomarker_id").notNull(), // matches our knowledge base IDs
  name: varchar("name").notNull(),
  value: decimal("value").notNull(),
  unit: varchar("unit").notNull(),
  referenceRangeLow: decimal("reference_range_low"),
  referenceRangeHigh: decimal("reference_range_high"),
  status: varchar("status"), // optimal, suboptimal-low, suboptimal-high, low, high, critical
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertBiomarkerEntrySchema = createInsertSchema(biomarkerEntries).omit({
  id: true,
  createdAt: true,
});

export type InsertBiomarkerEntry = z.infer<typeof insertBiomarkerEntrySchema>;
export type BiomarkerEntry = typeof biomarkerEntries.$inferSelect;

// Lab analysis reports - AI analysis results for manual lab entries
export const labAnalysisReports = pgTable("lab_analysis_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  labResultId: varchar("lab_result_id").notNull().references(() => labResults.id, { onDelete: "cascade" }),
  summary: text("summary"), // Executive summary
  findings: jsonb("findings").$type<Array<{
    title: string;
    description: string;
    severity: "info" | "warning" | "critical";
    biomarkerId?: string;
  }>>().default([]),
  patterns: jsonb("patterns").$type<Array<{
    name: string;
    description: string;
    biomarkerIds: string[];
  }>>().default([]),
  recommendations: jsonb("recommendations").$type<Array<{
    priority: number;
    title: string;
    description: string;
    category: "lifestyle" | "supplement" | "medical" | "testing";
  }>>().default([]),
  supplements: jsonb("supplements").$type<Array<{
    name: string;
    dose: string;
    timing: string;
    reason: string;
    duration?: string;
  }>>().default([]),
  followUpTests: jsonb("follow_up_tests").$type<Array<{
    name: string;
    reason: string;
  }>>().default([]),
  fullReport: text("full_report"), // Full markdown report
  aiModel: varchar("ai_model"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertLabAnalysisReportSchema = createInsertSchema(labAnalysisReports).omit({
  id: true,
  createdAt: true,
});

export type InsertLabAnalysisReport = z.infer<typeof insertLabAnalysisReportSchema>;
export type LabAnalysisReport = typeof labAnalysisReports.$inferSelect;

// ============================================================
// PHASE 5 & 6: PROVIDER & PRESCRIPTION TABLES
// ============================================================

// Provider license types
export const licenseTypes = ["MD", "NP", "PA", "DO"] as const;
export type LicenseType = typeof licenseTypes[number];

// Provider roles
export const providerRoles = ["PROVIDER", "ADMIN"] as const;
export type ProviderRole = typeof providerRoles[number];

// Providers - medical providers and admins
export const providers = pgTable("providers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id), // Link to user account
  email: varchar("email").notNull().unique(),
  firstName: varchar("first_name").notNull(),
  lastName: varchar("last_name").notNull(),
  licenseType: varchar("license_type").notNull(), // MD, NP, PA, DO
  licenseNumber: varchar("license_number"),
  licensedStates: text("licensed_states").array().default([]),
  role: varchar("role").notNull().default("PROVIDER"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertProviderSchema = createInsertSchema(providers).omit({
  id: true,
  createdAt: true,
});

export type InsertProvider = z.infer<typeof insertProviderSchema>;
export type Provider = typeof providers.$inferSelect;

// Review status enum
export const reviewStatuses = ["PENDING", "IN_REVIEW", "APPROVED", "DECLINED", "NEEDS_INFO"] as const;
export type ReviewStatus = typeof reviewStatuses[number];

// Provider reviews - review queue for clinical approval
export const providerReviews = pgTable("provider_reviews", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  chatSessionId: varchar("chat_session_id").notNull().references(() => chatSessions.id),
  providerId: varchar("provider_id").references(() => providers.id),
  status: varchar("status").notNull().default("PENDING"),
  aiSummary: text("ai_summary"),
  aiRecommendation: text("ai_recommendation"),
  providerNotes: text("provider_notes"),
  prescriptionDetails: jsonb("prescription_details").$type<{
    medication?: string;
    dosage?: string;
    frequency?: string;
    quantity?: number;
    refills?: number;
  }>(),
  lockedAt: timestamp("locked_at"), // When provider started review
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertProviderReviewSchema = createInsertSchema(providerReviews).omit({
  id: true,
  createdAt: true,
  lockedAt: true,
  completedAt: true,
});

export type InsertProviderReview = z.infer<typeof insertProviderReviewSchema>;
export type ProviderReview = typeof providerReviews.$inferSelect;

// Prescription status enum
export const prescriptionStatuses = ["PENDING", "APPROVED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"] as const;
export type PrescriptionStatus = typeof prescriptionStatuses[number];

// Prescriptions - medication orders and tracking
export const prescriptions = pgTable("prescriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  visibleId: varchar("visible_id").notNull().unique(), // e.g., "RX-4521"
  userId: varchar("user_id").notNull().references(() => users.id),
  reviewId: varchar("review_id").references(() => providerReviews.id),
  medication: varchar("medication").notNull(),
  dosage: varchar("dosage").notNull(),
  frequency: varchar("frequency").notNull(),
  quantity: integer("quantity").notNull(),
  refillsRemaining: integer("refills_remaining").default(0),
  status: varchar("status").notNull().default("PENDING"),
  pharmacyOrderId: varchar("pharmacy_order_id"),
  trackingNumber: varchar("tracking_number"),
  carrier: varchar("carrier"),
  estimatedDelivery: timestamp("estimated_delivery"),
  prescribedAt: timestamp("prescribed_at").defaultNow(),
  shippedAt: timestamp("shipped_at"),
  deliveredAt: timestamp("delivered_at"),
  nextRefillDate: timestamp("next_refill_date"),
});

export const insertPrescriptionSchema = createInsertSchema(prescriptions).omit({
  id: true,
  prescribedAt: true,
  shippedAt: true,
  deliveredAt: true,
});

export type InsertPrescription = z.infer<typeof insertPrescriptionSchema>;
export type Prescription = typeof prescriptions.$inferSelect;

// Audit logs - HIPAA compliance
export const auditLogs = pgTable("audit_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  providerId: varchar("provider_id").references(() => providers.id),
  action: varchar("action").notNull(), // e.g., "VIEW_LABS", "APPROVE_PRESCRIPTION"
  resource: varchar("resource").notNull(), // e.g., "lab_upload", "chat_session"
  resourceId: varchar("resource_id"),
  details: jsonb("details").$type<Record<string, unknown>>(),
  ipAddress: varchar("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AuditLog = typeof auditLogs.$inferSelect;

// ============================================================
// NEW RELATIONS
// ============================================================

export const chatSessionsRelations = relations(chatSessions, ({ one, many }) => ({
  user: one(users, {
    fields: [chatSessions.userId],
    references: [users.id],
  }),
  quizResponse: one(quizResponses, {
    fields: [chatSessions.quizResponseId],
    references: [quizResponses.id],
  }),
  messages: many(chatMessages),
  labUploads: many(labUploads),
  providerReview: one(providerReviews),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  session: one(chatSessions, {
    fields: [chatMessages.sessionId],
    references: [chatSessions.id],
  }),
}));

export const activityEventsRelations = relations(activityEvents, ({ one }) => ({
  user: one(users, {
    fields: [activityEvents.userId],
    references: [users.id],
  }),
}));

export const labUploadsRelations = relations(labUploads, ({ one }) => ({
  user: one(users, {
    fields: [labUploads.userId],
    references: [users.id],
  }),
  chatSession: one(chatSessions, {
    fields: [labUploads.chatSessionId],
    references: [chatSessions.id],
  }),
}));

export const providersRelations = relations(providers, ({ one, many }) => ({
  user: one(users, {
    fields: [providers.userId],
    references: [users.id],
  }),
  reviews: many(providerReviews),
}));

export const providerReviewsRelations = relations(providerReviews, ({ one }) => ({
  chatSession: one(chatSessions, {
    fields: [providerReviews.chatSessionId],
    references: [chatSessions.id],
  }),
  provider: one(providers, {
    fields: [providerReviews.providerId],
    references: [providers.id],
  }),
}));

export const prescriptionsRelations = relations(prescriptions, ({ one }) => ({
  user: one(users, {
    fields: [prescriptions.userId],
    references: [users.id],
  }),
  review: one(providerReviews, {
    fields: [prescriptions.reviewId],
    references: [providerReviews.id],
  }),
}));

// ============================================================
// PHASE 7: PRODUCT CATALOG & E-COMMERCE TABLES
// ============================================================

// Product category enum
export const productCategoryTypes = ["weight-loss", "hormones", "peptides", "sexual-health", "hair", "skin", "general-wellness"] as const;
export type ProductCategoryType = typeof productCategoryTypes[number];

// Product form types
export const productFormTypes = ["Injection", "Tablet", "Capsule", "Cream", "Gel", "Solution", "Troche", "Patch", "Nasal Spray", "Sublingual Drops", "Oral Dissolving Tablet", "Suppository", "Autoinjector", "Lyophilized Powder", "Other"] as const;
export type ProductFormType = typeof productFormTypes[number];

// Shipping types
export const shippingTypes = ["Room Temperature", "Refrigerated", "Freezer"] as const;
export type ShippingType = typeof shippingTypes[number];

// Order status enum
export const orderStatuses = ["PENDING", "AWAITING_PROVIDER", "APPROVED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"] as const;
export type OrderStatus = typeof orderStatuses[number];

// Pharmacies table - supplier partners
export const pharmacies = pgTable("pharmacies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: varchar("code").notNull().unique(), // A, B, C, D, E, G
  name: varchar("name").notNull(),
  isActive: boolean("is_active").default(true),
  noShipStates: text("no_ship_states").array().default([]), // States where this pharmacy can't ship
  createdAt: timestamp("created_at").defaultNow(),
});

export type Pharmacy = typeof pharmacies.$inferSelect;

// Products table - base product information with pricing
export const products = pgTable("products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  slug: varchar("slug").notNull().unique(), // URL-friendly name
  category: varchar("category").notNull(), // weight-loss, hormones, etc.
  form: varchar("form").notNull(), // Injection, Tablet, etc.
  description: text("description"),
  shortDescription: text("short_description"),
  benefits: text("benefits").array().default([]),
  sideEffects: text("side_effects").array().default([]),
  contraindications: text("contraindications").array().default([]),
  requiresPrescription: boolean("requires_prescription").default(true),
  isLegitScriptCertified: boolean("is_legitscript_certified").default(false),
  isActive: boolean("is_active").default(true),
  imageUrl: varchar("image_url"),
  // Pricing - simplified, no variants
  startingPrice: decimal("starting_price", { precision: 10, scale: 2 }), // Starting price displayed to users
  // Available options as descriptive text (e.g., "Available in 0.25mg, 0.5mg, 1mg injections")
  formOptions: text("form_options"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertProductSchema = createInsertSchema(products).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;

// Note: Product variants table removed - all pricing is now on the products table directly

// Orders table - customer purchases (supports no-login checkout flow)
export const orders = pgTable("orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  visibleId: varchar("visible_id").notNull().unique(), // e.g., "ORD-4521"
  userId: varchar("user_id").notNull().references(() => users.id),
  chatSessionId: varchar("chat_session_id").references(() => chatSessions.id),
  category: varchar("category"), // Treatment category from quiz (e.g., "weight-loss", "hormone-men")
  status: varchar("status").notNull().default("PENDING_PROVIDER_REVIEW"),
  subtotal: decimal("subtotal", { precision: 10, scale: 2 }).notNull(),
  shippingTotal: decimal("shipping_total", { precision: 10, scale: 2 }).notNull().default("0"),
  taxTotal: decimal("tax_total", { precision: 10, scale: 2 }).notNull().default("0"),
  total: decimal("total", { precision: 10, scale: 2 }).notNull(),
  stripePaymentIntentId: varchar("stripe_payment_intent_id"),
  stripeCheckoutSessionId: varchar("stripe_checkout_session_id"),
  paymentStatus: varchar("payment_status").default("pending_approval"), // pending_approval, awaiting_payment, paid, refunded
  shippingAddress: jsonb("shipping_address").$type<{
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zipCode: string;
    phone: string;
  }>(),
  // Intake data from quiz flow
  intakeAnswers: jsonb("intake_answers").$type<Record<string, unknown>>(),
  intakeContraindications: text("intake_contraindications").array().default([]),
  // Provider review fields
  providerReviewId: varchar("provider_review_id").references(() => providerReviews.id),
  providerApprovedAt: timestamp("provider_approved_at"),
  pharmacyOrderId: varchar("pharmacy_order_id"),
  trackingNumber: varchar("tracking_number"),
  carrier: varchar("carrier"),
  shippedAt: timestamp("shipped_at"),
  deliveredAt: timestamp("delivered_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  providerApprovedAt: true,
  shippedAt: true,
  deliveredAt: true,
});

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

// Order items table - individual products in an order
export const orderItems = pgTable("order_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: varchar("product_id").notNull().references(() => products.id),
  productName: varchar("product_name").notNull(), // Snapshot at time of order
  quantity: integer("quantity").notNull().default(1),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }).notNull(),
});

export const insertOrderItemSchema = createInsertSchema(orderItems).omit({
  id: true,
});

export type InsertOrderItem = z.infer<typeof insertOrderItemSchema>;
export type OrderItem = typeof orderItems.$inferSelect;

// Cart table - shopping cart persistence
export const carts = pgTable("carts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  sessionId: varchar("session_id"), // For guest carts
  chatSessionId: varchar("chat_session_id").references(() => chatSessions.id), // Link to AI consultation
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Cart = typeof carts.$inferSelect;

// Cart items table
export const cartItems = pgTable("cart_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cartId: varchar("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
  productVariantId: varchar("product_variant_id").notNull().references(() => products.id),
  quantity: integer("quantity").notNull().default(1),
  addedAt: timestamp("added_at").defaultNow(),
});

export type CartItem = typeof cartItems.$inferSelect;

// AI Product Recommendations - recommendations from AI consultation
export const aiRecommendations = pgTable("ai_recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  chatSessionId: varchar("chat_session_id").notNull().references(() => chatSessions.id),
  productId: varchar("product_id").notNull().references(() => products.id),
  reason: text("reason").notNull(), // AI's reasoning for recommendation
  priority: integer("priority").default(1), // 1 = primary, 2 = alternative, etc.
  isAccepted: boolean("is_accepted").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AiRecommendation = typeof aiRecommendations.$inferSelect;

// ============================================================
// PRODUCT CATALOG RELATIONS
// ============================================================

export const productsRelations = relations(products, ({ many }) => ({
  recommendations: many(aiRecommendations),
  orderItems: many(orderItems),
  cartItems: many(cartItems),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, {
    fields: [orders.userId],
    references: [users.id],
  }),
  chatSession: one(chatSessions, {
    fields: [orders.chatSessionId],
    references: [chatSessions.id],
  }),
  providerReview: one(providerReviews, {
    fields: [orders.providerReviewId],
    references: [providerReviews.id],
  }),
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  product: one(products, {
    fields: [orderItems.productId],
    references: [products.id],
  }),
}));

export const cartsRelations = relations(carts, ({ one, many }) => ({
  user: one(users, {
    fields: [carts.userId],
    references: [users.id],
  }),
  chatSession: one(chatSessions, {
    fields: [carts.chatSessionId],
    references: [chatSessions.id],
  }),
  items: many(cartItems),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, {
    fields: [cartItems.cartId],
    references: [carts.id],
  }),
  product: one(products, {
    fields: [cartItems.productVariantId],
    references: [products.id],
  }),
}));

export const aiRecommendationsRelations = relations(aiRecommendations, ({ one }) => ({
  chatSession: one(chatSessions, {
    fields: [aiRecommendations.chatSessionId],
    references: [chatSessions.id],
  }),
  product: one(products, {
    fields: [aiRecommendations.productId],
    references: [products.id],
  }),
}));

// Lab Orders for lab testing checkout flow
export const labOrders = pgTable("lab_orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  planType: varchar("plan_type").notNull(), // 'advanced' or 'base'
  priceCents: integer("price_cents").notNull(),
  status: varchar("status").notNull().default("draft"), // draft, pending_payment, paid, cancelled, shipped
  profile: jsonb("profile").$type<{
    firstName?: string;
    lastName?: string;
    dateOfBirth?: string;
    sex?: string;
    phone?: string;
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
  }>(),
  paymentIntentId: varchar("payment_intent_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertLabOrderSchema = createInsertSchema(labOrders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLabOrder = z.infer<typeof insertLabOrderSchema>;
export type LabOrder = typeof labOrders.$inferSelect;

export const labOrdersRelations = relations(labOrders, ({ one }) => ({
  user: one(users, {
    fields: [labOrders.userId],
    references: [users.id],
  }),
}));

// ============================================================
// PHASE 8: AI ADVISOR SYSTEM TABLES
// ============================================================

// Subscription tier enum — "free"/"aware" = free tier, "optimized" = paid ($27/mo)
export const subscriptionTiers = ["free", "aware", "optimized"] as const;
export type SubscriptionTier = typeof subscriptionTiers[number];

// Subscription status enum
export const subscriptionStatuses = ["active", "cancelled", "past_due", "trialing"] as const;
export type SubscriptionStatus = typeof subscriptionStatuses[number];

// User subscriptions - subscription tier management
export const subscriptions = pgTable("subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id).unique(),
  tier: varchar("tier").notNull().default("free"), // free/aware = free tier, optimized = paid
  status: varchar("status").notNull().default("active"),
  period: varchar("period").default("monthly"), // monthly, annual
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSubscriptionSchema = createInsertSchema(subscriptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptions.$inferSelect;

// AI usage tracking - daily rate limits
export const aiUsage = pgTable("ai_usage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  date: varchar("date").notNull(), // YYYY-MM-DD format
  messageCount: integer("message_count").notNull().default(0),
  tokensInput: integer("tokens_input").notNull().default(0),
  tokensOutput: integer("tokens_output").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("IDX_ai_usage_user_date").on(table.userId, table.date),
]);

export const insertAiUsageSchema = createInsertSchema(aiUsage).omit({
  id: true,
  createdAt: true,
});

export type InsertAiUsage = z.infer<typeof insertAiUsageSchema>;
export type AiUsage = typeof aiUsage.$inferSelect;

// AI Advisor conversations - separate from clinical intake
export const aiAdvisorConversations = pgTable("ai_advisor_conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  title: varchar("title"),
  path: varchar("path"), // symptoms, optimize, questions, freeform
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAiAdvisorConversationSchema = createInsertSchema(aiAdvisorConversations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAiAdvisorConversation = z.infer<typeof insertAiAdvisorConversationSchema>;
export type AiAdvisorConversation = typeof aiAdvisorConversations.$inferSelect;

// AI Advisor messages
export const aiAdvisorMessages = pgTable("ai_advisor_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => aiAdvisorConversations.id, { onDelete: "cascade" }),
  role: varchar("role").notNull(), // user, assistant
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<{
    tokensInput?: number;
    tokensOutput?: number;
    model?: string;
  }>(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAiAdvisorMessageSchema = createInsertSchema(aiAdvisorMessages).omit({
  id: true,
  createdAt: true,
});

export type InsertAiAdvisorMessage = z.infer<typeof insertAiAdvisorMessageSchema>;
export type AiAdvisorMessage = typeof aiAdvisorMessages.$inferSelect;

// Saved protocols — user-saved multi-phase protocols generated by Atlas chat.
// Populated via the "Save Protocol" button in /advisor when Atlas emits a
// ```protocol block. Rendered in the "My Saved Protocols" section of the
// Protocol tab. Per-item completion is NOT wired here — that's Phase 4 work.
export type SavedProtocolItem = {
  title: string;
  type?: "supplement" | "lifestyle" | "stop";
  dosage?: string;
  timing?: string;
  description?: string;
};

export type SavedProtocolPhase = {
  name: string;
  duration?: string;
  items: SavedProtocolItem[];
};

export const savedProtocols = pgTable("saved_protocols", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description"),
  source: varchar("source", { length: 40 }).notNull().default("atlas_chat"),
  conversationId: varchar("conversation_id").references(() => aiAdvisorConversations.id, { onDelete: "set null" }),
  phases: jsonb("phases").$type<SavedProtocolPhase[]>().default([]),
  lifestyleItems: jsonb("lifestyle_items").$type<Array<{ title: string; description?: string }>>().default([]),
  stopItems: jsonb("stop_items").$type<string[]>().default([]),
  supplements: jsonb("supplements").$type<Array<{ name: string; dosage?: string; timing?: string }>>().default([]),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_saved_protocols_user").on(table.userId, table.createdAt),
]);

export const insertSavedProtocolSchema = createInsertSchema(savedProtocols).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSavedProtocol = z.infer<typeof insertSavedProtocolSchema>;
export type SavedProtocol = typeof savedProtocols.$inferSelect;

// Audit v3 Fix 10 — LLM history import
export const aiImports = pgTable("ai_imports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  source: varchar("source", { length: 40 }).notNull(), // chatgpt|claude|grok|perplexity
  rawText: text("raw_text").notNull(),
  parsed: jsonb("parsed").$type<Record<string, unknown> | null>().default(null),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_ai_imports_user").on(table.userId, table.createdAt),
]);

export const insertAiImportSchema = createInsertSchema(aiImports).omit({
  id: true,
  createdAt: true,
});
export type InsertAiImport = z.infer<typeof insertAiImportSchema>;
export type AiImport = typeof aiImports.$inferSelect;

// Lab analysis results - enhanced biomarker analysis from AI
export const labAnalysis = pgTable("lab_analysis", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  labUploadId: varchar("lab_upload_id").references(() => labUploads.id),
  name: varchar("name"), // Lab panel name
  collectionDate: varchar("collection_date"),
  source: varchar("source").default("upload"), // upload, manual
  biomarkers: jsonb("biomarkers").$type<Array<{
    name: string;
    value: number | string;
    unit: string;
    status: "optimal" | "low" | "high" | "critical" | "unknown";
    optimalRange?: { low: number; high: number };
    referenceRange?: string;
  }>>().default([]),
  aiAnalysis: jsonb("ai_analysis").$type<{
    summary?: string;
    keyFindings?: string[];
    patterns?: string[];
    priorityRecommendations?: string[];
    supplementProtocol?: Array<{
      name: string;
      dose: string;
      reason: string;
      priority: "high" | "medium" | "low";
    }>;
    lifestyleChanges?: string[];
    retestRecommendations?: string[];
    providerAlerts?: string[];
    analyzedAt?: string;
  }>(),
  status: varchar("status").notNull().default("pending"), // pending, analyzing, analyzed, error
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertLabAnalysisSchema = createInsertSchema(labAnalysis).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLabAnalysis = z.infer<typeof insertLabAnalysisSchema>;
export type LabAnalysis = typeof labAnalysis.$inferSelect;

// Phase 8 Relations
export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}));

export const aiUsageRelations = relations(aiUsage, ({ one }) => ({
  user: one(users, {
    fields: [aiUsage.userId],
    references: [users.id],
  }),
}));

export const aiAdvisorConversationsRelations = relations(aiAdvisorConversations, ({ one, many }) => ({
  user: one(users, {
    fields: [aiAdvisorConversations.userId],
    references: [users.id],
  }),
  messages: many(aiAdvisorMessages),
}));

export const aiAdvisorMessagesRelations = relations(aiAdvisorMessages, ({ one }) => ({
  conversation: one(aiAdvisorConversations, {
    fields: [aiAdvisorMessages.conversationId],
    references: [aiAdvisorConversations.id],
  }),
}));

export const labAnalysisRelations = relations(labAnalysis, ({ one }) => ({
  user: one(users, {
    fields: [labAnalysis.userId],
    references: [users.id],
  }),
  labUpload: one(labUploads, {
    fields: [labAnalysis.labUploadId],
    references: [labUploads.id],
  }),
}));

// =====================================
// DAILY ENGAGEMENT TABLES
// =====================================

// Daily Check-ins table
export const dailyCheckins = pgTable("daily_checkins", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  date: varchar("date").notNull(), // YYYY-MM-DD format
  mood: integer("mood"), // 1-5 scale
  energyLevel: integer("energy_level"), // 1-5 scale
  sleepQuality: integer("sleep_quality"), // 1-5 scale
  stressLevel: integer("stress_level"), // 1-5 scale (1=high stress, 5=low stress)
  notes: text("notes"),
  xpAwarded: integer("xp_awarded").default(15),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_daily_checkins_user_date").on(table.userId, table.date),
]);

export const insertDailyCheckinSchema = createInsertSchema(dailyCheckins).omit({
  id: true,
  createdAt: true,
});

export type InsertDailyCheckin = z.infer<typeof insertDailyCheckinSchema>;
export type DailyCheckin = typeof dailyCheckins.$inferSelect;

// Task Definitions table (seeded data)
export const taskDefinitions = pgTable("task_definitions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskKey: varchar("task_key").unique().notNull(),
  title: varchar("title").notNull(),
  description: text("description"),
  xpValue: integer("xp_value").default(5),
  icon: varchar("icon"),
  relatedBiomarkers: text("related_biomarkers").array(),
  category: varchar("category"),
});

export const insertTaskDefinitionSchema = createInsertSchema(taskDefinitions).omit({
  id: true,
});

export type InsertTaskDefinition = z.infer<typeof insertTaskDefinitionSchema>;
export type TaskDefinition = typeof taskDefinitions.$inferSelect;

// User Daily Tasks table
export const userDailyTasks = pgTable("user_daily_tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  date: varchar("date").notNull(), // YYYY-MM-DD format
  taskKey: varchar("task_key").notNull(),
  completed: boolean("completed").default(false),
  completedAt: timestamp("completed_at"),
  xpAwarded: integer("xp_awarded").default(0),
}, (table) => [
  index("idx_user_daily_tasks_user_date").on(table.userId, table.date),
]);

export const insertUserDailyTaskSchema = createInsertSchema(userDailyTasks).omit({
  id: true,
});

export type InsertUserDailyTask = z.infer<typeof insertUserDailyTaskSchema>;
export type UserDailyTask = typeof userDailyTasks.$inferSelect;

// Relations for daily engagement tables
export const dailyCheckinsRelations = relations(dailyCheckins, ({ one }) => ({
  user: one(users, {
    fields: [dailyCheckins.userId],
    references: [users.id],
  }),
}));

export const userDailyTasksRelations = relations(userDailyTasks, ({ one }) => ({
  user: one(users, {
    fields: [userDailyTasks.userId],
    references: [users.id],
  }),
}));

// =====================================
// PERSONALIZED PROTOCOL SYSTEM TABLES
// =====================================

// Biomarker action type
export type BiomarkerAction = {
  id: string;
  title: string;
  description: string;
  xp: number;
  impact: "high" | "medium" | "low";
  icon: string;
  whyItWorks?: string;
  research?: string;
  expectedImpact?: string;
  evidenceLevel?: "strong" | "moderate" | "emerging";
  proTips?: string[];
  aiChatPrompts?: string[];
};

// Supplement recommendation type
export type SupplementRec = {
  name: string;
  dosage: string;
  frequency: string;
  timing: string;
  how_it_helps: string;
  evidence_rating: number;
};

// Food item type
export type FoodItem = {
  name: string;
  reason: string;
};

// Peptide type
export type PeptideRec = {
  name: string;
  description: string;
  use_case: string;
};

// Biomarker protocols - master table of protocols for each biomarker
export const biomarkerProtocols = pgTable("biomarker_protocols", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  biomarkerKey: varchar("biomarker_key").notNull().unique(), // 'testosterone_total', 'crp', 'ldl', etc.
  biomarkerDisplayName: varchar("biomarker_display_name").notNull(), // 'Testosterone', 'C-Reactive Protein'
  category: varchar("category").notNull(), // 'hormones', 'inflammation', 'cardiovascular', etc.
  actions: jsonb("actions").$type<BiomarkerAction[]>().default([]),
  supplements: jsonb("supplements").$type<SupplementRec[]>().default([]),
  foodsToEat: jsonb("foods_to_eat").$type<FoodItem[]>().default([]),
  foodsToAvoid: jsonb("foods_to_avoid").$type<FoodItem[]>().default([]),
  peptides: jsonb("peptides").$type<PeptideRec[]>().default([]),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_biomarker_protocols_key").on(table.biomarkerKey),
]);

export const insertBiomarkerProtocolSchema = createInsertSchema(biomarkerProtocols).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBiomarkerProtocol = z.infer<typeof insertBiomarkerProtocolSchema>;
export type BiomarkerProtocol = typeof biomarkerProtocols.$inferSelect;

// User daily protocols - tracks user's daily protocol assignments and completions
export const userDailyProtocols = pgTable("user_daily_protocols", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  date: varchar("date").notNull(), // YYYY-MM-DD format
  protocol: jsonb("protocol").notNull(), // Generated protocol for the day
  completedActions: jsonb("completed_actions").$type<string[]>().default([]), // Array of action IDs completed
  totalXpEarned: integer("total_xp_earned").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_user_daily_protocols_user_date").on(table.userId, table.date),
]);

export const insertUserDailyProtocolSchema = createInsertSchema(userDailyProtocols).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUserDailyProtocol = z.infer<typeof insertUserDailyProtocolSchema>;
export type UserDailyProtocol = typeof userDailyProtocols.$inferSelect;

// Supplements - master supplement database
export const supplements = pgTable("supplements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  slug: varchar("slug").notNull().unique(),
  typicalDosage: varchar("typical_dosage"),
  dosageFrequency: varchar("dosage_frequency"), // 'daily', 'twice daily'
  timing: varchar("timing"), // 'morning', 'evening', 'with food'
  description: text("description"),
  howItHelps: text("how_it_helps"),
  evidenceRating: integer("evidence_rating"), // 1-5 stars
  helpsBiomarkers: jsonb("helps_biomarkers").$type<string[]>().default([]), // Array of biomarker_keys
  productId: varchar("product_id").references(() => products.id),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSupplementSchema = createInsertSchema(supplements).omit({
  id: true,
  createdAt: true,
});

export type InsertSupplement = z.infer<typeof insertSupplementSchema>;
export type Supplement = typeof supplements.$inferSelect;

// Atlas-Selected Fullscript catalog — hand-curated supplement shelf rendered
// via Fullscript embeddable product cards. Separate from `supplements` (which
// tracks personal stack items) and from `products` (which is the legacy
// marketplace table). Product IDs come from Paul's Fullscript store under
// store_slug="pclotar".
export const supplementCatalog = pgTable("supplement_catalog", {
  id: varchar("id").primaryKey(), // stable slug, e.g., "thorne-basic-b-complex"
  fullscriptProductId: varchar("fullscript_product_id").notNull(), // "70589"
  displayName: varchar("display_name").notNull(), // "Basic B Complex"
  brand: varchar("brand"), // "Thorne" — nullable; oembed doesn't expose brand
  form: varchar("form"), // "glycinate", "methylated", "liposomal" when material
  categoryIds: jsonb("category_ids").$type<string[]>().default([]).notNull(), // ["foundation","metabolic"]
  biomarkerTargets: jsonb("biomarker_targets").$type<string[]>().default([]).notNull(), // registry ids
  whyThisOne: text("why_this_one"), // one-line curation rationale
  primaryBenefit: text("primary_benefit"), // customer-facing
  typicalDose: varchar("typical_dose"),
  certifications: jsonb("certifications").$type<string[]>().default([]).notNull(), // ["NSF_SPORT","USP","IFOS"]
  evidenceTier: integer("evidence_tier").default(2).notNull(), // 1 RCT, 2 mechanism+cohort, 3 traditional
  atlasSelected: boolean("atlas_selected").default(true).notNull(),
  active: boolean("active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSupplementCatalogSchema = createInsertSchema(supplementCatalog).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertSupplementCatalog = z.infer<typeof insertSupplementCatalogSchema>;
export type SupplementCatalog = typeof supplementCatalog.$inferSelect;

// User supplement stack - user's current supplement stack
export const userSupplementStack = pgTable("user_supplement_stack", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  supplementId: varchar("supplement_id").notNull().references(() => supplements.id),
  customDosage: varchar("custom_dosage"), // If different from typical
  timing: varchar("timing"), // 'morning', 'evening'
  startedAt: varchar("started_at"), // Date when started
  active: boolean("active").default(true),
}, (table) => [
  index("idx_user_supplement_stack_user").on(table.userId),
]);

export const insertUserSupplementStackSchema = createInsertSchema(userSupplementStack).omit({
  id: true,
});

export type InsertUserSupplementStack = z.infer<typeof insertUserSupplementStackSchema>;
export type UserSupplementStack = typeof userSupplementStack.$inferSelect;

// Protocol system relations
export const biomarkerProtocolsRelations = relations(biomarkerProtocols, ({ }) => ({}));

export const userDailyProtocolsRelations = relations(userDailyProtocols, ({ one }) => ({
  user: one(users, {
    fields: [userDailyProtocols.userId],
    references: [users.id],
  }),
}));

export const supplementsRelations = relations(supplements, ({ one, many }) => ({
  product: one(products, {
    fields: [supplements.productId],
    references: [products.id],
  }),
  userStacks: many(userSupplementStack),
}));

export const userSupplementStackRelations = relations(userSupplementStack, ({ one }) => ({
  user: one(users, {
    fields: [userSupplementStack.userId],
    references: [users.id],
  }),
  supplement: one(supplements, {
    fields: [userSupplementStack.supplementId],
    references: [supplements.id],
  }),
}));

// ============================================================
// DAILY TASK COMPLETIONS - Tracks individual task completions with timestamps
// ============================================================

export const taskCompletionTypes = ["protocol_action", "foundation", "check_in"] as const;
export type TaskCompletionType = typeof taskCompletionTypes[number];

export const userTaskCompletions = pgTable("user_task_completions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  taskId: varchar("task_id").notNull(), // Unique identifier for the task (e.g., "protocol-action-123", "foundation-sleep")
  taskType: varchar("task_type").notNull(), // "protocol_action", "foundation", "check_in"
  xpEarned: integer("xp_earned").default(0),
  completedAt: timestamp("completed_at").defaultNow(),
  dateKey: varchar("date_key").notNull(), // YYYY-MM-DD in user's timezone - for quick daily queries
}, (table) => [
  index("idx_user_task_completions_user_date").on(table.userId, table.dateKey),
  index("idx_user_task_completions_user_task").on(table.userId, table.taskId, table.dateKey),
]);

export const insertUserTaskCompletionSchema = createInsertSchema(userTaskCompletions).omit({
  id: true,
  completedAt: true,
});

export type InsertUserTaskCompletion = z.infer<typeof insertUserTaskCompletionSchema>;
export type UserTaskCompletion = typeof userTaskCompletions.$inferSelect;

export const userTaskCompletionsRelations = relations(userTaskCompletions, ({ one }) => ({
  user: one(users, {
    fields: [userTaskCompletions.userId],
    references: [users.id],
  }),
}));

// ============================================================
// BIOMARKER CONTENT CACHE - AI-generated biomarker descriptions
// ============================================================

export const biomarkerContent = pgTable("biomarker_content", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  biomarkerName: varchar("biomarker_name").notNull().unique(),
  category: varchar("category"),
  whatIsIt: text("what_is_it"),
  whyItMatters: text("why_it_matters"),
  howToOptimize: jsonb("how_to_optimize").$type<string[]>().default([]),
  generatedAt: timestamp("generated_at").defaultNow(),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("idx_biomarker_content_name").on(table.biomarkerName),
]);

export const insertBiomarkerContentSchema = createInsertSchema(biomarkerContent).omit({
  id: true,
  generatedAt: true,
});

export type InsertBiomarkerContent = z.infer<typeof insertBiomarkerContentSchema>;
export type BiomarkerContent = typeof biomarkerContent.$inferSelect;

// ============================================================
// WEARABLE CONNECTIONS - OAuth connections to health devices
// ============================================================

export const wearableProviders = ["oura", "whoop", "apple_health", "fitbit", "garmin", "eight_sleep", "dexcom", "libre"] as const;
export type WearableProvider = typeof wearableProviders[number];

export const wearableSyncStatuses = ["pending", "syncing", "success", "error"] as const;
export type WearableSyncStatus = typeof wearableSyncStatuses[number];

export const wearableConnections = pgTable("wearable_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider").notNull(), // oura, whoop, apple_health, fitbit, garmin
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at"),
  scopes: text("scopes").array(),
  connectedAt: timestamp("connected_at").defaultNow(),
  lastSyncAt: timestamp("last_sync_at"),
  syncStatus: varchar("sync_status").default("pending"), // pending, syncing, success, error
  isActive: boolean("is_active").default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
}, (table) => [
  index("idx_wearable_connections_user").on(table.userId),
  index("idx_wearable_connections_user_provider").on(table.userId, table.provider),
]);

export const insertWearableConnectionSchema = createInsertSchema(wearableConnections).omit({
  id: true,
  connectedAt: true,
});

export type InsertWearableConnection = z.infer<typeof insertWearableConnectionSchema>;
export type WearableConnection = typeof wearableConnections.$inferSelect;

// ============================================================
// WEARABLE DAILY METRICS - Aggregated daily health metrics from wearables
// ============================================================

export const wearableDailyMetrics = pgTable("wearable_daily_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  date: varchar("date").notNull(), // YYYY-MM-DD format
  
  // Sleep metrics
  sleepTotalMinutes: integer("sleep_total_minutes"),
  sleepDeepMinutes: integer("sleep_deep_minutes"),
  sleepRemMinutes: integer("sleep_rem_minutes"),
  sleepEfficiency: decimal("sleep_efficiency", { precision: 5, scale: 2 }),
  sleepScore: integer("sleep_score"),
  
  // Recovery metrics
  recoveryScore: integer("recovery_score"),
  hrvAvg: decimal("hrv_avg", { precision: 6, scale: 2 }),
  restingHeartRate: integer("resting_heart_rate"),
  respiratoryRate: decimal("respiratory_rate", { precision: 4, scale: 1 }),
  
  // Activity metrics
  steps: integer("steps"),
  activeCalories: integer("active_calories"),
  activeMinutes: integer("active_minutes"),
  strain: decimal("strain", { precision: 4, scale: 2 }),
  workoutCount: integer("workout_count"),
  
  // Calculated score
  readinessScore: integer("readiness_score"),
  
  // Eight Sleep metrics
  sleepTemperatureAvg: decimal("sleep_temperature_avg", { precision: 4, scale: 1 }),
  sleepTemperatureMin: decimal("sleep_temperature_min", { precision: 4, scale: 1 }),
  sleepTemperatureMax: decimal("sleep_temperature_max", { precision: 4, scale: 1 }),
  bedClimateLevel: integer("bed_climate_level"), // -10 to +10 heating/cooling level
  sleepLatencyMinutes: integer("sleep_latency_minutes"),
  sleepTossTurnCount: integer("sleep_toss_turn_count"),
  eightSleepScore: integer("eight_sleep_score"),
  
  // CGM/Glucose metrics
  glucoseAvg: decimal("glucose_avg", { precision: 5, scale: 1 }),
  glucoseMin: decimal("glucose_min", { precision: 5, scale: 1 }),
  glucoseMax: decimal("glucose_max", { precision: 5, scale: 1 }),
  glucoseVariability: decimal("glucose_variability", { precision: 5, scale: 2 }), // Standard deviation
  timeInRange: decimal("time_in_range", { precision: 5, scale: 2 }), // Percentage 70-140 mg/dL
  timeAboveRange: decimal("time_above_range", { precision: 5, scale: 2 }), // Percentage above 140
  timeBelowRange: decimal("time_below_range", { precision: 5, scale: 2 }), // Percentage below 70
  glucoseSpikesCount: integer("glucose_spikes_count"), // Number of spikes above 160
  
  // Data sources
  sources: jsonb("sources").$type<string[]>().default([]),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_wearable_metrics_user_date").on(table.userId, table.date),
]);

export const insertWearableDailyMetricsSchema = createInsertSchema(wearableDailyMetrics).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWearableDailyMetrics = z.infer<typeof insertWearableDailyMetricsSchema>;
export type WearableDailyMetrics = typeof wearableDailyMetrics.$inferSelect;

export const wearableConnectionsRelations = relations(wearableConnections, ({ one }) => ({
  user: one(users, {
    fields: [wearableConnections.userId],
    references: [users.id],
  }),
}));

export const wearableDailyMetricsRelations = relations(wearableDailyMetrics, ({ one }) => ({
  user: one(users, {
    fields: [wearableDailyMetrics.userId],
    references: [users.id],
  }),
}));

// ============================================================
// USER SUPPLEMENTS - Track supplements, peptides, and medications
// ============================================================

export const supplementTypes = ["supplement", "peptide", "medication", "vitamin", "herb", "amino_acid", "probiotic", "other"] as const;
export type SupplementType = typeof supplementTypes[number];

export const supplementFrequencies = ["daily", "twice_daily", "three_times_daily", "weekly", "as_needed", "with_meals", "morning", "evening", "bedtime"] as const;
export type SupplementFrequency = typeof supplementFrequencies[number];

export const userSupplements = pgTable("user_supplements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  
  // Basic info
  name: varchar("name").notNull(),
  brand: varchar("brand"),
  type: varchar("type").notNull().default("supplement"), // supplement, peptide, medication, vitamin, herb, amino_acid, probiotic, other
  
  // Dosage info
  dosage: varchar("dosage"), // e.g., "500mg", "2 capsules", "1ml"
  dosageUnit: varchar("dosage_unit"), // mg, mcg, IU, ml, capsules, tablets
  frequency: varchar("frequency"), // daily, twice_daily, with_meals, etc.
  timing: varchar("timing"), // morning, evening, with_food, empty_stomach
  
  // Additional details
  description: text("description"), // User notes or AI-extracted info
  ingredients: text("ingredients"), // Full ingredient list from label
  purpose: varchar("purpose"), // What it's for: "energy", "sleep", "muscle", etc.
  
  // Image uploads
  imageUrl: varchar("image_url"), // Primary product image
  labelImageUrl: varchar("label_image_url"), // Supplement facts label
  
  // AI analysis
  aiAnalyzed: boolean("ai_analyzed").default(false),
  aiSummary: text("ai_summary"), // AI-generated summary of the supplement
  aiRecommendations: jsonb("ai_recommendations").$type<{
    synergies?: string[];
    conflicts?: string[];
    biomarkerRelevance?: string[];
    dosageNotes?: string;
  }>(),
  
  // Status
  isActive: boolean("is_active").default(true), // Currently taking
  startedAt: timestamp("started_at"),
  endedAt: timestamp("ended_at"),

  // Source tracking — where this stack entry came from
  // "manual" (default — user typed/photographed it)
  // "fullscript" (user confirmed an order via "I Ordered This" on a card)
  // "ai_recommendation" (accepted from Atlas stack generator)
  source: varchar("source").default("manual"),
  sourceProductId: varchar("source_product_id"), // Fullscript product_id when source=fullscript
  catalogId: varchar("catalog_id"), // supplement_catalog.id when added from our curated shelf
  orderedAt: timestamp("ordered_at"), // When the user said they ordered it

  // Metadata
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_user_supplements_user").on(table.userId),
  index("idx_user_supplements_active").on(table.userId, table.isActive),
]);

export const insertUserSupplementSchema = createInsertSchema(userSupplements).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUserSupplement = z.infer<typeof insertUserSupplementSchema>;
export type UserSupplement = typeof userSupplements.$inferSelect;

export const userSupplementsRelations = relations(userSupplements, ({ one }) => ({
  user: one(users, {
    fields: [userSupplements.userId],
    references: [users.id],
  }),
}));

// ============================================================
// USER ONBOARDING - Track user journey progress
// ============================================================

export const onboardingSteps = ["profile", "labs", "wearables", "supplements", "goals", "complete"] as const;
export type OnboardingStep = typeof onboardingSteps[number];

export const userOnboarding = pgTable("user_onboarding", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }).unique(),
  
  // Step completion status
  completedSteps: jsonb("completed_steps").$type<OnboardingStep[]>().default([]),
  currentStep: varchar("current_step").default("profile"),
  
  // Individual step metadata
  profileCompletedAt: timestamp("profile_completed_at"),
  labsUploadedAt: timestamp("labs_uploaded_at"),
  wearablesConnectedAt: timestamp("wearables_connected_at"),
  supplementsAddedAt: timestamp("supplements_added_at"),
  goalsSetAt: timestamp("goals_set_at"),
  
  // Overall status
  isComplete: boolean("is_complete").default(false),
  completedAt: timestamp("completed_at"),
  skippedSteps: jsonb("skipped_steps").$type<OnboardingStep[]>().default([]),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_user_onboarding_user").on(table.userId),
]);

export const insertUserOnboardingSchema = createInsertSchema(userOnboarding).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUserOnboarding = z.infer<typeof insertUserOnboardingSchema>;
export type UserOnboarding = typeof userOnboarding.$inferSelect;

export const userOnboardingRelations = relations(userOnboarding, ({ one }) => ({
  user: one(users, {
    fields: [userOnboarding.userId],
    references: [users.id],
  }),
}));

// Health Profile table — stores Atlas profile builder responses
export const healthProfiles = pgTable("health_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }).unique(),
  age: integer("age"),
  sex: varchar("sex"),
  heightFeet: integer("height_feet"),
  heightInches: integer("height_inches"),
  weight: integer("weight"),
  goals: jsonb("goals").$type<string[]>().default([]),
  symptoms: jsonb("symptoms").$type<string[]>().default([]),
  medications: text("medications"),
  supplements: text("supplements"),
  allergies: text("allergies"),
  exerciseLevel: varchar("exercise_level"),
  dietType: varchar("diet_type"),
  sleepHours: varchar("sleep_hours"),
  stressLevel: varchar("stress_level"),
  medicalHistory: text("medical_history"),
  familyHistory: text("family_history"),
  protocolPreferences: jsonb("protocol_preferences").$type<{
    focusAreas?: string[];
    avoidActions?: string[];
    intensityPreference?: "low" | "moderate" | "high";
    dietaryRestrictions?: string[];
    updatedAt?: string;
  }>(),
  isComplete: boolean("is_complete").default(false),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_health_profiles_user").on(table.userId),
]);

export const insertHealthProfileSchema = createInsertSchema(healthProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertHealthProfile = z.infer<typeof insertHealthProfileSchema>;
export type HealthProfile = typeof healthProfiles.$inferSelect;

export const healthProfilesRelations = relations(healthProfiles, ({ one }) => ({
  user: one(users, {
    fields: [healthProfiles.userId],
    references: [users.id],
  }),
}));

export const blogPosts = pgTable("blog_posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  excerpt: text("excerpt").notNull(),
  content: text("content").notNull(),
  author: text("author").notNull(),
  coverImage: text("cover_image"),
  published: boolean("published").default(false),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_blog_posts_slug").on(table.slug),
  index("idx_blog_posts_published").on(table.published),
]);

export const insertBlogPostSchema = createInsertSchema(blogPosts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBlogPost = z.infer<typeof insertBlogPostSchema>;
export type BlogPost = typeof blogPosts.$inferSelect;

export const RecommendationStatus = ["pending_review", "approved", "denied", "purchased"] as const;
export type RecommendationStatusType = typeof RecommendationStatus[number];

export const OrderStatus = ["pending", "processing", "shipped", "delivered", "cancelled"] as const;
export type OrderStatusType = typeof OrderStatus[number];

export const fullscriptPatients = pgTable("fullscript_patients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  fullscriptPatientId: varchar("fullscript_patient_id"),
  email: varchar("email").notNull(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_fullscript_patients_user").on(table.userId),
]);

export const insertFullscriptPatientSchema = createInsertSchema(fullscriptPatients).omit({
  id: true,
  createdAt: true,
});
export type InsertFullscriptPatient = z.infer<typeof insertFullscriptPatientSchema>;
export type FullscriptPatient = typeof fullscriptPatients.$inferSelect;

export const supplementRecommendations = pgTable("supplement_recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  status: varchar("status").notNull().default("pending_review"),
  reason: text("reason"),
  targetedBiomarkers: jsonb("targeted_biomarkers").$type<string[]>().default([]),
  aiReasoning: text("ai_reasoning"),
  practitionerNotes: text("practitioner_notes"),
  approvedById: varchar("approved_by_id"),
  approvedAt: timestamp("approved_at"),
  deniedAt: timestamp("denied_at"),
  denialReason: text("denial_reason"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_supplement_recs_user").on(table.userId),
  index("idx_supplement_recs_status").on(table.status),
]);

export const insertSupplementRecommendationSchema = createInsertSchema(supplementRecommendations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSupplementRecommendation = z.infer<typeof insertSupplementRecommendationSchema>;
export type SupplementRecommendation = typeof supplementRecommendations.$inferSelect;

export const recommendationItems = pgTable("recommendation_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  recommendationId: varchar("recommendation_id").notNull().references(() => supplementRecommendations.id),
  fullscriptProductId: varchar("fullscript_product_id"),
  productName: varchar("product_name").notNull(),
  brandName: varchar("brand_name"),
  dosage: varchar("dosage"),
  frequency: varchar("frequency"),
  notes: text("notes"),
  priceAmount: decimal("price_amount"),
  imageUrl: varchar("image_url"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_rec_items_recommendation").on(table.recommendationId),
]);

export const insertRecommendationItemSchema = createInsertSchema(recommendationItems).omit({
  id: true,
  createdAt: true,
});
export type InsertRecommendationItem = z.infer<typeof insertRecommendationItemSchema>;
export type RecommendationItem = typeof recommendationItems.$inferSelect;

export const supplementOrders = pgTable("supplement_orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  recommendationId: varchar("recommendation_id").references(() => supplementRecommendations.id),
  fullscriptOrderId: varchar("fullscript_order_id"),
  status: varchar("status").notNull().default("pending"),
  totalAmount: decimal("total_amount"),
  trackingNumber: varchar("tracking_number"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_supplement_orders_user").on(table.userId),
  index("idx_supplement_orders_recommendation").on(table.recommendationId),
]);

export const insertSupplementOrderSchema = createInsertSchema(supplementOrders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSupplementOrder = z.infer<typeof insertSupplementOrderSchema>;
export type SupplementOrder = typeof supplementOrders.$inferSelect;

export const supplementRecommendationRelations = relations(supplementRecommendations, ({ one, many }) => ({
  user: one(users, {
    fields: [supplementRecommendations.userId],
    references: [users.id],
  }),
  items: many(recommendationItems),
  orders: many(supplementOrders),
}));

export const recommendationItemRelations = relations(recommendationItems, ({ one }) => ({
  recommendation: one(supplementRecommendations, {
    fields: [recommendationItems.recommendationId],
    references: [supplementRecommendations.id],
  }),
}));

export const supplementOrderRelations = relations(supplementOrders, ({ one }) => ({
  user: one(users, {
    fields: [supplementOrders.userId],
    references: [users.id],
  }),
  recommendation: one(supplementRecommendations, {
    fields: [supplementOrders.recommendationId],
    references: [supplementRecommendations.id],
  }),
}));

// ─── DEXA Scan Results ────────────────────────────────────────────────────────
export const dexaResults = pgTable("dexa_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  scanDate: varchar("scan_date").notNull(),
  source: varchar("source").notNull().default("manual_entry"),

  totalBodyFatPercent: decimal("total_body_fat_percent", { precision: 5, scale: 2 }),
  visceralAdiposeTissue: decimal("visceral_adipose_tissue", { precision: 8, scale: 2 }),
  androidFatPercent: decimal("android_fat_percent", { precision: 5, scale: 2 }),
  gynoidFatPercent: decimal("gynoid_fat_percent", { precision: 5, scale: 2 }),
  androidGynoidRatio: decimal("android_gynoid_ratio", { precision: 4, scale: 2 }),

  totalLeanMass: decimal("total_lean_mass", { precision: 8, scale: 2 }),
  appendicularLeanMassIndex: decimal("appendicular_lean_mass_index", { precision: 5, scale: 2 }),

  boneMineralDensity: decimal("bone_mineral_density", { precision: 5, scale: 3 }),
  tScoreLumbar: decimal("t_score_lumbar", { precision: 4, scale: 2 }),
  tScoreHip: decimal("t_score_hip", { precision: 4, scale: 2 }),
  zScore: decimal("z_score", { precision: 4, scale: 2 }),

  rawData: jsonb("raw_data"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_dexa_user").on(table.userId, table.scanDate),
]);

export const insertDexaResultSchema = createInsertSchema(dexaResults).omit({
  id: true,
  createdAt: true,
});
export type InsertDexaResult = z.infer<typeof insertDexaResultSchema>;
export type DexaResult = typeof dexaResults.$inferSelect;

// ─── VO2 Max Results ──────────────────────────────────────────────────────────
export const vo2Results = pgTable("vo2_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  testDate: varchar("test_date").notNull(),
  source: varchar("source").notNull().default("manual_entry"),

  vo2MaxRelative: decimal("vo2_max_relative", { precision: 5, scale: 2 }),
  vo2MaxAbsolute: decimal("vo2_max_absolute", { precision: 5, scale: 2 }),
  anaerobicThreshold: decimal("anaerobic_threshold", { precision: 5, scale: 2 }),
  maxHeartRate: integer("max_heart_rate"),
  testProtocol: varchar("test_protocol"),

  percentileForAge: integer("percentile_for_age"),
  fitnessCategory: varchar("fitness_category"),

  estimatedFromWearable: boolean("estimated_from_wearable").default(false),
  wearableSource: varchar("wearable_source"),

  rawData: jsonb("raw_data"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_vo2_user").on(table.userId, table.testDate),
]);

export const insertVo2ResultSchema = createInsertSchema(vo2Results).omit({
  id: true,
  createdAt: true,
});
export type InsertVo2Result = z.infer<typeof insertVo2ResultSchema>;
export type Vo2Result = typeof vo2Results.$inferSelect;

export const waitlistEntries = pgTable("waitlist_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  firstName: varchar("first_name", { length: 100 }),
  lastName: varchar("last_name", { length: 100 }),
  email: varchar("email", { length: 320 }).notNull().unique(),
  phone: varchar("phone", { length: 30 }),
  source: varchar("source", { length: 100 }).default("website"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_waitlist_email").on(table.email),
]);

export const insertWaitlistEntrySchema = createInsertSchema(waitlistEntries).omit({
  id: true,
  createdAt: true,
});
export type InsertWaitlistEntry = z.infer<typeof insertWaitlistEntrySchema>;
export type WaitlistEntry = typeof waitlistEntries.$inferSelect;

export const cmsContent = pgTable("cms_content", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  contentType: text("content_type").notNull().default("blog"),
  content: text("content"),
  introduction: text("introduction"),
  status: text("status").notNull().default("draft"),
  featuredImage: text("featured_image"),
  excerpt: text("excerpt"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  keywords: text("keywords"),
  focusKeyword: text("focus_keyword"),
  heading1: text("heading1"),
  contentBlock1: text("content_block1"),
  heading2: text("heading2"),
  contentBlock2: text("content_block2"),
  locationTitle: text("location_title"),
  locationHook: text("location_hook"),
  directAnswer: text("direct_answer"),
  serviceArea: text("service_area"),
  serviceDetails: text("service_details"),
  scenarioQuestions: text("scenario_questions"),
  comparisonBlock: text("comparison_block"),
  internalLinks: text("internal_links"),
  trustComplianceSection: text("trust_compliance_section"),
  secondAeoAnchor: text("second_aeo_anchor"),
  cta1Title: text("cta1_title"),
  cta1Button: text("cta1_button"),
  buttonUrl1: text("button_url1"),
  buttonText1: text("button_text1"),
  cta2Title: text("cta2_title"),
  cta2Button: text("cta2_button"),
  buttonUrl2: text("button_url2"),
  buttonText2: text("button_text2"),
  cta3Title: text("cta3_title"),
  cta3Button: text("cta3_button"),
  buttonUrl3: text("button_url3"),
  buttonText3: text("button_text3"),
  wordCount: integer("word_count"),
  faqs: jsonb("faqs"),
  faqSchema: jsonb("faq_schema"),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_cms_content_slug").on(table.slug),
  index("idx_cms_content_type").on(table.contentType),
  index("idx_cms_content_status").on(table.status),
]);

export const insertCmsContentSchema = createInsertSchema(cmsContent).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  contentType: z.enum(["blog", "seo_page", "location_page"]).default("blog"),
  status: z.enum(["draft", "published"]).default("draft"),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })).nullable().optional(),
  faqSchema: z.record(z.unknown()).nullable().optional(),
});
export type InsertCmsContent = z.infer<typeof insertCmsContentSchema>;
export type CmsContent = typeof cmsContent.$inferSelect;

export const cmsImages = pgTable("cms_images", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  url: text("url").notNull().unique(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  altText: text("alt_text"),
  caption: text("caption"),
  source: text("source").default("api"),
  sourceContentSlug: text("source_content_slug"),
  tags: jsonb("tags").default([]),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_cms_images_source").on(table.source),
  index("idx_cms_images_slug").on(table.sourceContentSlug),
]);

export const insertCmsImageSchema = createInsertSchema(cmsImages).omit({
  id: true,
  createdAt: true,
}).extend({
  tags: z.array(z.string()).nullable().optional(),
});
export type InsertCmsImage = z.infer<typeof insertCmsImageSchema>;
export type CmsImage = typeof cmsImages.$inferSelect;

export const templateSettings = pgTable("template_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  templateType: text("template_type").notNull().unique(),
  accentColor: text("accent_color").default("#0EA57A"),
  headingColor: text("heading_color").default("#ffffff"),
  bodyColor: text("body_color").default("#d1d5db"),
  backgroundColor: text("background_color").default("#080d17"),
  cardColor: text("card_color").default("#0d1424"),
  ctaButtonColor: text("cta_button_color").default("#0EA57A"),
  headingFontSize: text("heading_font_size").default("2.5rem"),
  contentWidth: text("content_width").default("720px"),
  heroStyle: text("hero_style").default("dark"),
  bodyFontSize: text("body_font_size").default("base"),
  faqStyle: text("faq_style").default("accordion"),
  showFaq: boolean("show_faq").default(true),
  sectionPadding: text("section_padding").default("normal"),
  sidebarPosition: text("sidebar_position").default("hidden"),
  calendlyUrl: text("calendly_url"),
  showCalendly: boolean("show_calendly").default(false),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTemplateSettingsSchema = createInsertSchema(templateSettings).omit({
  id: true,
  updatedAt: true,
});
export type InsertTemplateSettings = z.infer<typeof insertTemplateSettingsSchema>;
export type TemplateSettings = typeof templateSettings.$inferSelect;

// ============================================================
// WEARABLE DATA — Raw wearable data points (granular storage)
// ============================================================

export const wearableData = pgTable("wearable_data", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  connectionId: varchar("connection_id").references(() => wearableConnections.id, { onDelete: "set null" }),
  provider: varchar("provider", { length: 50 }).notNull(),
  dataType: varchar("data_type", { length: 50 }).notNull(),
  date: date("date").notNull(),
  value: jsonb("value").notNull(),
  sourceId: varchar("source_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_wearable_data_user_date").on(table.userId, table.date),
  index("idx_wearable_data_type").on(table.userId, table.provider, table.dataType),
]);

export const insertWearableDataSchema = createInsertSchema(wearableData).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWearableData = z.infer<typeof insertWearableDataSchema>;
export type WearableData = typeof wearableData.$inferSelect;

export const wearableDataRelations = relations(wearableData, ({ one }) => ({
  user: one(users, {
    fields: [wearableData.userId],
    references: [users.id],
  }),
  connection: one(wearableConnections, {
    fields: [wearableData.connectionId],
    references: [wearableConnections.id],
  }),
}));

// ============================================================
// SUPPLEMENT STACK CACHE - Stable biomarker-driven supplement stack
// ============================================================

export const supplementStackCache = pgTable("supplement_stack_cache", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  stack: jsonb("stack").notNull(),
  labUploadId: varchar("lab_upload_id"),
  generatedAt: timestamp("generated_at").defaultNow(),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("idx_supplement_stack_cache_user").on(table.userId),
]);

export const insertSupplementStackCacheSchema = createInsertSchema(supplementStackCache).omit({
  id: true,
  generatedAt: true,
});
export type InsertSupplementStackCache = z.infer<typeof insertSupplementStackCacheSchema>;
export type SupplementStackCache = typeof supplementStackCache.$inferSelect;

export const supplementStackCacheRelations = relations(supplementStackCache, ({ one }) => ({
  user: one(users, {
    fields: [supplementStackCache.userId],
    references: [users.id],
  }),
}));

// ============================================================
// SUPPLEMENT WISHLIST - Atlas-recommended supplements user saved
// ============================================================

export const supplementWishlist = pgTable("supplement_wishlist", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  supplementName: text("supplement_name").notNull(),
  dosage: text("dosage"),
  reason: text("reason"),
  source: text("source").default("atlas_chat"),
  fullscriptProductId: text("fullscript_product_id"),
  fullscriptProductUrl: text("fullscript_product_url"),
  addedAt: timestamp("added_at").defaultNow(),
}, (table) => [
  index("idx_supplement_wishlist_user").on(table.userId),
]);

export const insertSupplementWishlistSchema = createInsertSchema(supplementWishlist).omit({
  id: true,
  addedAt: true,
});
export type InsertSupplementWishlist = z.infer<typeof insertSupplementWishlistSchema>;
export type SupplementWishlist = typeof supplementWishlist.$inferSelect;

export const supplementWishlistRelations = relations(supplementWishlist, ({ one }) => ({
  user: one(users, {
    fields: [supplementWishlist.userId],
    references: [users.id],
  }),
}));
