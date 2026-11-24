import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per avatar profile. Queryable fields are columns; the full
// avatar-profile v1.0 payload (background, images, image_base, speech,
// voice, switch_settings, origin) lives in `data` as JSON.
export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  data: text("data").notNull(),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
});

// Version snapshots of a profile (kept to the latest 20 per profile).
export const profileHistory = sqliteTable("profile_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: text("profile_id").notNull(),
  snapshot: text("snapshot").notNull(),
  label: text("label").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Switch requests queued for the chat-side agent (design v1.1 §0, A+B).
export const switchRequests = sqliteTable("switch_requests", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull(),
  status: text("status", {
    enum: ["pending", "processing", "completed", "failed"],
  })
    .notNull()
    .default("pending"),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Generation requests for the chat-side agent: image generation, reference
// link summaries, trial conversations, profile_apply (CR-03: apply an
// edit to the currently active avatar right away), flavor_examples
// (CR-12: auto-generate example lines for flavor traits whose
// auto_examples flag is on and whose examples are empty), and
// video_transcript (CR-17: fetch the transcripts of the profile's
// 参考動画URL and mine the dialogue for tone material). The SQL column
// is plain TEXT, so a new kind needs no migration.
export const generationRequests = sqliteTable("generation_requests", {
  id: text("id").primaryKey(),
  profileId: text("profile_id"),
  kind: text("kind", {
    enum: [
      "image_generation",
      "link_summary",
      "trial_conversation",
      "profile_apply",
      "flavor_examples",
      "video_transcript",
    ],
  }).notNull(),
  payload: text("payload").notNull().default("{}"),
  status: text("status", {
    enum: ["pending", "processing", "completed", "failed"],
  })
    .notNull()
    .default("pending"),
  result: text("result"),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
