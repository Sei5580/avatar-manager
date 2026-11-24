// Actions for アバター総合管理 (avatar-profile format v1.0, design v1.1).
//
// A Space cannot switch the real avatar or generate avatar images itself
// (design §0 / R-01). Switching, image generation, link summaries, and trial
// conversations are queued as requests in the DB; the chat-side agent picks
// them up (listPending*) and writes results back (complete*). Conversation
// history is never passed anywhere: switch_settings.pass_conversation_summary
// is format-only, always false, and has no UI or code path.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export const ELEMENT_KEYS = [
  "性別の印象",
  "年齢層",
  "髪型・髪色",
  "目の色",
  "眼鏡・目の見え方",
  "体型",
  "服装",
  "頭部装飾",
  "持ち物・小物",
  "メインカラー",
  "雰囲気・表情",
  "画風",
  "背景",
] as const;

const elementsSchema = z
  .object({
    "性別の印象": z.string().max(200).default(""),
    "年齢層": z.string().max(200).default(""),
    "髪型・髪色": z.string().max(300).default(""),
    "目の色": z.string().max(200).default(""),
    "眼鏡・目の見え方": z.string().max(300).default(""),
    "体型": z.string().max(300).default(""),
    "服装": z.string().max(300).default(""),
    "頭部装飾": z.string().max(300).default(""),
    "持ち物・小物": z.string().max(300).default(""),
    "メインカラー": z.string().max(200).default(""),
    "雰囲気・表情": z.string().max(300).default(""),
    "画風": z.string().max(200).default(""),
    "背景": z.string().max(200).default("白（固定）"),
  })
  .default({
    "性別の印象": "",
    "年齢層": "",
    "髪型・髪色": "",
    "目の色": "",
    "眼鏡・目の見え方": "",
    "体型": "",
    "服装": "",
    "頭部装飾": "",
    "持ち物・小物": "",
    "メインカラー": "",
    "雰囲気・表情": "",
    "画風": "",
    "背景": "白（固定）",
  });

const tuningSchema = z.object({
  politeness: z.number().int().min(1).max(5).default(3),
  brightness: z.number().int().min(1).max(5).default(3),
  length: z.number().int().min(1).max(5).default(3),
  emoji: z.number().int().min(1).max(5).default(3),
  free_note: z.string().max(1000).default(""),
});

// CR-06: structured speech fields. Each field carries a value plus a
// source flag ("auto" = written back by the chat-side generation, "manual"
// = typed/corrected by the user). Manual fields win: generation
// write-backs never overwrite them. call_user_as stays the top-level
// profile field (linked); only its source flag lives in speech.sources.
export const SPEECH_FIELD_KEYS = [
  "first_person",
  "second_person",
  "call_user_as",
  "catchphrase",
  "memo",
  "style",
] as const;
type SpeechFieldKey = (typeof SPEECH_FIELD_KEYS)[number];

const speechSourceSchema = z.enum(["auto", "manual"]);

const speechStructuredSchema = z.object({
  first_person: z.string().max(500).nullable().default(null),
  second_person: z.string().max(500).nullable().default(null),
  catchphrase: z.string().max(1000).nullable().default(null),
  memo: z.string().max(2000).nullable().default(null),
});

const speechSourcesSchema = z.object({
  first_person: speechSourceSchema.nullable().default(null),
  second_person: speechSourceSchema.nullable().default(null),
  call_user_as: speechSourceSchema.nullable().default(null),
  catchphrase: speechSourceSchema.nullable().default(null),
  memo: speechSourceSchema.nullable().default(null),
  style: speechSourceSchema.nullable().default(null),
});

const emptySpeechStructured: z.infer<typeof speechStructuredSchema> = {
  first_person: null,
  second_person: null,
  catchphrase: null,
  memo: null,
};
const emptySpeechSources: z.infer<typeof speechSourcesSchema> = {
  first_person: null,
  second_person: null,
  call_user_as: null,
  catchphrase: null,
  memo: null,
  style: null,
};

// CR-08: フレーバー設定 — 「キャラクターらしさ」の中身（項目リスト）と
// 量（レベル 0〜5）。各項目は名前・例文（複数可）・出る場面・有効/無効・
// 出自（auto/manual）を持つ。口調欄（CR-06）と同じ手動優先ルール：
// ユーザーが追加・編集した項目は "manual" になり、生成の書き戻しでは
// 上書き・削除されない。書き戻しは "auto" 項目だけを対象にマージされる（CR-20）。
// レベルはユーザーのバー調整が正で、書き戻しでは変更されない。
export const FLAVOR_SCENE_PRESETS = [
  "挨拶時",
  "完了時",
  "成功時",
  "失敗時",
  "ふだん",
] as const;

const flavorTraitSchema = z.object({
  id: z.string().max(200),
  label: z.string().max(200).default(""),
  examples: z.array(z.string().max(1000)).max(10).default([]),
  scenes: z.array(z.string().max(100)).max(10).default([]),
  enabled: z.boolean().default(true),
  source: z.enum(["auto", "manual"]).default("manual"),
  // CR-12: 「例文を自動作成」 — when on and the trait has no examples,
  // saving the profile queues a flavor_examples generation request so
  // the chat side invents example lines for this trait. Traits created
  // by the full-auto URL flow (generation write-backs) default to on;
  // traits added by hand in the form default to off. Legacy traits parse
  // with false, so existing profiles change in no other way.
  auto_examples: z.boolean().default(false),
  // CR-14: per-trait frequency (0-5). null = unset = follow the global
  // level (flavor.level). A number overrides the global level for this
  // trait only, with the same stage meanings as the global bar
  // (0 = never show this trait, 1-2 = only at key moments, 3 = naturally
  // at milestones, 4-5 = frequently). Legacy traits parse with null, so
  // existing profiles keep following the global level exactly as before.
  frequency: z.number().int().min(0).max(5).nullable().default(null),
});

const flavorSchema = z.object({
  level: z.number().int().min(0).max(5).default(3),
  traits: z.array(flavorTraitSchema).max(50).default([]),
});

// CR-14: merged view handed to the chat side — each trait additionally
// carries its effective frequency (trait.frequency ?? global level) so
// the chat side never has to guess which value applies.
const mergedFlavorTraitSchema = flavorTraitSchema.extend({
  effective_frequency: z.number().int().min(0).max(5),
  frequency_is_custom: z.boolean(),
});
const mergedFlavorSchema = z.object({
  level: z.number().int().min(0).max(5),
  traits: z.array(mergedFlavorTraitSchema).default([]),
});

export function effectiveFlavorFrequency(
  trait: { frequency?: number | null },
  globalLevel: number,
): number {
  return trait.frequency ?? globalLevel;
}

const emptyFlavor: z.infer<typeof flavorSchema> = { level: 3, traits: [] };

// CR-10: テーマカラー — each profile carries a theme color that tints its
// cards (list + focus). Source semantics mirror CR-06/CR-08 manual
// priority: "manual" (picked by the user in the edit screen) is never
// overwritten by automatic acquisition; "auto" was acquired automatically
// (the representative image's dominant color, extracted client-side and
// passed in as a candidate, or inferred server-side from the appearance
// elements — メインカラー first, then 服装 / 髪型・髪色）; "default" is
// the fallback when nothing could be acquired.
export const DEFAULT_THEME_COLOR = "#64748b";

const themeColorSourceSchema = z.enum(["auto", "manual", "default"]);

const THEME_COLOR_KEYWORDS: [string, string][] = [
  ["水色", "#0284c7"],
  ["赤", "#c1272d"],
  ["青", "#2563eb"],
  ["緑", "#15803d"],
  ["黄", "#ca8a04"],
  ["紫", "#7c3aed"],
  ["ピンク", "#db2777"],
  ["黒", "#1f2937"],
  ["白", "#94a3b8"],
  ["茶", "#92400e"],
  ["金", "#b45309"],
  ["銀", "#64748b"],
  ["オレンジ", "#ea580c"],
  ["グレー", "#6b7280"],
  ["灰", "#6b7280"],
];

function isValidThemeColor(v: string | null | undefined): boolean {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

function inferThemeColorFromElements(
  elements: z.infer<typeof elementsSchema>,
): string | null {
  const fields = [
    elements["メインカラー"],
    elements["服装"],
    elements["髪型・髪色"],
    elements["頭部装飾"],
  ];
  for (const f of fields) {
    if (!f) continue;
    for (const [kw, hex] of THEME_COLOR_KEYWORDS) {
      if (f.includes(kw)) return hex;
    }
  }
  return null;
}

const imageEntrySchema = z.object({
  id: z.string(),
  file: z.string(),
  blob_key: z.string().nullable().default(null),
  is_primary: z.boolean().default(false),
  source: z.string().default("upload"),
});

const preparationItemSchema = z.enum(["done", "pending", "none", "failed"]);

const preparationSchema = z.object({
  image: preparationItemSchema.default("none"),
  link_summary: preparationItemSchema.default("none"),
  greeting: preparationItemSchema.default("pending"),
  // CR-17: 参考動画 (video_transcript). "none" when the profile has no
  // video URLs at all — the item is then 対象外 and never affects the
  // ready judgment, exactly as before this change.
  video: preparationItemSchema.default("none"),
  status: z
    .enum(["preparing", "ready", "needs_attention"])
    .default("preparing"),
});

// Why the last generation for each preparation item failed, kept on the
// profile itself so the list/detail UI can show the reason and offer a
// retry without digging through the request queue (D-03 / R-06).
const preparationErrorsSchema = z.object({
  image: z.string().max(1000).nullable().default(null),
  link_summary: z.string().max(1000).nullable().default(null),
  greeting: z.string().max(1000).nullable().default(null),
  // CR-17: why the last video_transcript attempt failed (or which videos
  // could not be read at all).
  video: z.string().max(1000).nullable().default(null),
});

const profileDataSchema = z.object({
  summary: z.string().max(300).default(""),
  greeting: z.string().max(5000).default(""),
  preparation: preparationSchema.default({
    image: "none",
    link_summary: "none",
    greeting: "pending",
    video: "none",
    status: "preparing",
  }),
  preparation_errors: preparationErrorsSchema.default({
    image: null,
    link_summary: null,
    greeting: null,
    video: null,
  }),
  background: z.object({
    text: z.string().max(20000).default(""),
    links: z.array(z.string().max(2000)).max(20).default([]),
    link_summary: z.string().max(5000).nullable().default(null),
    unreadable_links: z.array(z.string().max(2000)).max(20).default([]),
    // CR-07: 「私の扱い」 — from this character's point of view, what the
    // user is to them (master, friend, a close associate's friend whose
    // body they are borrowing, …). Optional free text (preset chips in
    // the UI just fill this field). Null/empty means unspecified: the
    // treatment is inferred naturally from the background / call_user_as
    // as before. When set, greeting generation, switch, and
    // profile_apply payloads carry it and the chat side treats it as
    // authoritative for distance/attitude toward the user.
    user_relationship: z.string().max(2000).nullable().default(null),
    // CR-19: 「演じる姿・状況」 (portrayal_focus) — an optional free-text
    // bias toward one specific portrayal / situation of the character
    // (e.g. 中学生の時のみ / 闇落ちした状態 / もしも〜だったら). It is
    // deliberately NOT framed as a "period": any state, form, or what-if
    // setting can be written. Null/empty means unused: NO bias is applied
    // anywhere — generation uses all material as before, acting has no
    // extra premise, preparation judgments are unchanged, and payloads
    // carry no portrayal keys at all. When set, generation payloads
    // (link_summary / video_transcript / flavor_examples /
    // image_generation) carry the value plus an instruction to use ONLY
    // the material matching that portrayal/situation (for videos, the
    // matching chapters/segments) and to report back instead of filling
    // the gap from other states when nothing matches; switch /
    // profile_apply / trial payloads carry it as the premise to act in
    // that portrayal/situation. Legacy profiles parse with null, so
    // existing profiles gain the field empty and nothing else changes.
    portrayal_focus: z.string().max(2000).nullable().default(null),
    // CR-21: the outcome of checking whether the CURRENT portrayal_focus
    // can actually be honored by the source material. "unknown" = not
    // judged yet (no completed link_summary / video_transcript check for
    // the current value); "ok" = at least one completed check found
    // matching material (bias effective); "failed" = every completed
    // check reported no matching material and none found any — the bias
    // is then treated as INACTIVE (payloads carry no portrayal keys,
    // exactly like an unused field) while the profile itself stays
    // fully usable and its preparation status is unaffected. The check
    // state is generation-managed: user edits never set it directly,
    // and changing / clearing portrayal_focus resets it to "unknown"
    // (CR-20's re-queue re-judges it). Legacy profiles parse with
    // "unknown" / null / empty checks, so nothing changes for them.
    portrayal_focus_status: z
      .enum(["unknown", "ok", "failed"])
      .default("unknown"),
    portrayal_focus_failure_reason: z
      .string()
      .max(1000)
      .nullable()
      .default(null),
    portrayal_focus_checks: z
      .object({
        link_summary: z.enum(["match", "no_match"]).nullable().default(null),
        video_transcript: z
          .enum(["match", "no_match"])
          .nullable()
          .default(null),
      })
      .default({ link_summary: null, video_transcript: null }),
    // CR-17: 参考動画URL — video URLs (YouTube etc.) kept SEPARATE from
    // `links`: a video is not read as a web page; the chat side fetches
    // its transcript (字幕/文字起こし) and mines the dialogue for tone
    // material. Legacy profiles parse with an empty list.
    video_urls: z.array(z.string().max(2000)).max(20).default([]),
    // CR-17: what the dialogue revealed about the character's tone,
    // written back by a video_transcript request ({video_notes}).
    // Carried in switch / profile_apply / trial payloads as tone
    // reference material.
    video_notes: z.string().max(5000).nullable().default(null),
    // CR-17: videos whose transcript could not be obtained in the last
    // completed video_transcript batch (entries are the URLs as the
    // chat side reported them, possibly with a reason appended).
    unreadable_videos: z.array(z.string().max(2000)).max(20).default([]),
    // CR-17: bookkeeping for the queue rule — the video URLs the last
    // video_transcript attempt (completed or failed) already covered.
    // A current video_url missing here is 未処理 and (re)queues a
    // request on save; attempted URLs never auto-requeue, so a failure
    // stays visible until a manual retry.
    video_processed_urls: z.array(z.string().max(2000)).max(20).default([]),
  }),
  images: z.array(imageEntrySchema).max(30).default([]),
  image_base: z.object({
    type: z.enum(["image", "elements", "none"]).default("none"),
    image_ref: z.string().max(2000).nullable().default(null),
    elements: elementsSchema,
  }),
  call_user_as: z.string().max(500).nullable().default(null),
  speech: z.object({
    style: z.string().max(5000).nullable().default(null),
    inferred: z.boolean().default(false),
    tuning: tuningSchema.default({
      politeness: 3,
      brightness: 3,
      length: 3,
      emoji: 3,
      free_note: "",
    }),
    structured: speechStructuredSchema.default(emptySpeechStructured),
    sources: speechSourcesSchema.default(emptySpeechSources),
  }),
  // CR-08: フレーバー設定（量レベル＋項目リスト）。旧プロファイルには
  // 既定値（level 3 / 空の traits）が補われるだけで、既存内容は不変。
  flavor: flavorSchema.default(emptyFlavor),
  // CR-10: テーマカラー。旧プロファイルには既定色＋"default" が補われ、
  // 読み取り時に normalizeThemeColor が要素から推定できれば "auto" に
  // 初期設定する（それ以外の内容は不変）。
  theme_color: z.string().max(20).default(DEFAULT_THEME_COLOR),
  theme_color_source: themeColorSourceSchema.default("default"),
  voice: z.object({
    reserved: z.literal(true).default(true),
    kind: z.string().max(200).nullable().default(null),
    speed: z.string().max(50).nullable().default(null),
  }),
  avatar_memory: z.string().max(20000).default(""),
  switch_settings: z.object({
    pass_conversation_summary: z.literal(false).default(false),
    use_shared_info: z.boolean().default(true),
  }),
  origin: z.object({
    type: z.enum(["app", "imported", "auto_saved"]).default("app"),
    chat_link: z.string().max(2000).nullable().default(null),
  }),
  candidate_id: z.string().max(500).nullable().default(null),
});

type ProfileData = z.infer<typeof profileDataSchema>;

const profileInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  data: profileDataSchema,
  favorite: z.boolean().default(false),
});

type PreparationItem = z.infer<typeof preparationItemSchema>;

function calcPreparation(data: ProfileData): z.infer<typeof preparationSchema> {
  // A stored "failed" state is sticky: it survives recomputation until a new
  // request is queued (createGenerationRequest flips it back to pending) or
  // the item's content actually arrives. This is what keeps a failed
  // generation visible instead of silently reverting to 準備中 (D-03).
  let image: PreparationItem;
  if (data.image_base.type === "none") image = "none";
  // Failed wins over an existing image: the item tracks the latest
  // generation attempt (a failed regeneration must stay visible, D-03).
  // Registering a replacement image clears it explicitly in
  // uploadImage / addImageByUrl.
  else if (data.preparation?.image === "failed") image = "failed";
  else if (data.images.length > 0) image = "done";
  else if (data.image_base.type === "image" && data.image_base.image_ref) image = "done";
  else if (data.image_base.type === "elements") image = data.preparation?.image === "done" ? "done" : "pending";
  else if (data.preparation?.image === "pending" && data.image_base.type === "image") image = "pending";
  else image = "none";

  let link_summary: PreparationItem;
  // A stored "pending" hint wins while links exist: it means a (re)generation
  // request is queued (create flow, manual request, or an edit that changed
  // the links), even if a previous summary text is still on file. A stored
  // "failed" wins over both: the latest regeneration attempt failed and the
  // user must see that (with its reason) until they retry.
  if (data.background.links.length > 0 && data.preparation?.link_summary === "failed")
    link_summary = "failed";
  else if (data.background.links.length > 0 && data.preparation?.link_summary === "pending")
    link_summary = "pending";
  else if (data.background.link_summary && data.background.link_summary.trim())
    link_summary = "done";
  else if (data.background.links.length > 0) link_summary = "pending";
  else link_summary = "none";

  // A failed trial/greeting generation stays failed even when an older
  // greeting text is still on file: the failure is about the latest attempt,
  // and it clears only when a new request is queued or one completes.
  let greeting: PreparationItem;
  if (data.preparation?.greeting === "failed") greeting = "failed";
  else if (data.greeting && data.greeting.trim()) greeting = "done";
  else greeting = "pending";

  // CR-17: 参考動画. No video URLs → "none" (対象外): the item never
  // affects the status, so video-less profiles keep the exact previous
  // ready judgment. With URLs, a stored failed/pending hint is sticky
  // like the other items; otherwise the state derives from the stored
  // material: every current URL attempted (video_processed_urls) with
  // notes on file (or a partially readable batch) is done, every URL
  // unreadable with no notes at all is failed, and anything not yet
  // attempted is pending.
  let video: PreparationItem;
  const videoUrls = (data.background.video_urls ?? [])
    .map((u) => u.trim())
    .filter(Boolean);
  if (videoUrls.length === 0) video = "none";
  else if (data.preparation?.video === "failed") video = "failed";
  else if (data.preparation?.video === "pending") video = "pending";
  else {
    const processed = new Set(
      (data.background.video_processed_urls ?? []).map((u) => u.trim()),
    );
    const allProcessed = videoUrls.every((u) => processed.has(u));
    if (!allProcessed) video = "pending";
    else {
      const unreadable = data.background.unreadable_videos ?? [];
      const allUnreadable = videoUrls.every((u) =>
        unreadable.some((e) => e === u || e.startsWith(u)),
      );
      const hasNotes = !!(
        data.background.video_notes && data.background.video_notes.trim()
      );
      video = allUnreadable && !hasNotes ? "failed" : "done";
    }
  }

  const status: "preparing" | "ready" | "needs_attention" =
    image === "failed" ||
    link_summary === "failed" ||
    greeting === "failed" ||
    video === "failed"
      ? "needs_attention"
      : image === "pending" ||
          link_summary === "pending" ||
          greeting === "pending" ||
          video === "pending"
        ? "preparing"
        : "ready";
  return { image, link_summary, greeting, video, status };
}

// CR-06 migration/read path: legacy profiles have speech.style /
// call_user_as values but no structured fields or source flags. Their
// values stay exactly as they are; a value that exists without a recorded
// source is treated as "manual" (it was supplied through the app or an
// import), so future auto write-backs cannot silently replace it. Empty
// structured fields stay empty (null source) until a generation writes
// them back as "auto" or the user types into them ("manual").
function normalizeSpeechSources(data: ProfileData): ProfileData {
  const sources = { ...emptySpeechSources, ...data.speech.sources };
  const structured = { ...emptySpeechStructured, ...data.speech.structured };
  let changed = false;
  const fill = (key: SpeechFieldKey, value: string | null | undefined) => {
    if (value && value.trim() && !sources[key]) {
      sources[key] = "manual";
      changed = true;
    }
    if (!value && sources[key]) {
      // A source flag without a value is meaningless; drop it.
      sources[key] = null;
      changed = true;
    }
  };
  fill("first_person", structured.first_person);
  fill("second_person", structured.second_person);
  fill("catchphrase", structured.catchphrase);
  fill("memo", structured.memo);
  fill("call_user_as", data.call_user_as);
  fill("style", data.speech.style);
  const structuredDiff =
    JSON.stringify(structured) !== JSON.stringify(data.speech.structured);
  if (!changed && !structuredDiff) return data;
  return { ...data, speech: { ...data.speech, structured, sources } };
}

function speechFieldValue(
  data: ProfileData,
  key: SpeechFieldKey,
): string | null {
  if (key === "call_user_as") return data.call_user_as;
  if (key === "style") return data.speech.style;
  return data.speech.structured[key];
}

// The merged (manual-priority) speech view handed to the chat side in
// switch / profile_apply payloads and generation requests: stored values
// already ARE the merge result, because manual values are never
// overwritten by auto write-backs.
function mergedSpeechView(data: ProfileData) {
  return {
    first_person: data.speech.structured.first_person,
    second_person: data.speech.structured.second_person,
    call_user_as: data.call_user_as,
    catchphrase: data.speech.structured.catchphrase,
    memo: data.speech.structured.memo,
    style: data.speech.style,
    tuning: data.speech.tuning,
  };
}

function manualSpeechFields(data: ProfileData): SpeechFieldKey[] {
  return SPEECH_FIELD_KEYS.filter(
    (k) => data.speech.sources[k] === "manual",
  );
}

// ---------------------------------------------------------------------------
// CR-19: 「演じる姿・状況」 (portrayal_focus) payload helpers
// ---------------------------------------------------------------------------

// The stored value, normalized: a non-empty trimmed string, or null when
// the field is unused. EVERY portrayal payload inclusion keys off this:
// null → no portrayal keys and no bias instruction anywhere (the payload
// stays exactly as before this change).
function portrayalFocusValue(data: ProfileData): string | null {
  const v = data.background.portrayal_focus?.trim();
  return v ? v : null;
}

// Bias instruction for material-based generation (link_summary /
// flavor_examples): use only the parts of the sources that match the
// specified portrayal/situation. CR-21: when NOTHING in the sources
// matches, do NOT let the summary/tone collapse into a "no material"
// text — ignore the bias, build from ALL the material as usual, and
// report the miss in the write-back (portrayal_focus_no_match: true
// plus portrayal_focus_no_match_reason) so the app can mark the
// specification as failed and show the reason.
function portrayalGenerationNote(pf: string): string {
  return `portrayal_focus（演じる姿・状況）として「${pf}」が指定されています。資料のうち、この姿・状況に当たる部分だけを材料にしてください。他の時期・状態の内容で勝手に補わないでください。指定の姿・状況に当たる資料が無い場合は、バイアス指定を無視して資料全体から通常どおり要約・口調を作ってください（要約や口調を「該当資料はありませんでした」という文面そのものに置き換えないでください）。そのうえで、result に portrayal_focus_no_match: true と portrayal_focus_no_match_reason（例: 参考リンクに指定の姿・状況の記述がない、といった理由文）を必ず含めてください。当たる資料が見つかった場合は portrayal_focus_no_match を含めないでください。`;
}

// Bias instruction for video_transcript: same filtering rule, plus the
// chapter/segment selection the video case needs. CR-21: the same
// fall-back contract as portrayalGenerationNote — no matching segment
// means build from the whole transcript as usual and report the miss
// with a reason, never replace video_notes with a "no material" text.
function portrayalVideoNote(pf: string): string {
  return `portrayal_focus（演じる姿・状況）として「${pf}」が指定されています。各動画の文字起こしのうち、この姿・状況に当たるチャプター・区間だけを選んで材料にしてください。他の時期・状態の台詞で勝手に補わないでください。指定の姿・状況に当たるチャプター・区間が無い場合は、バイアス指定を無視して文字起こし全体から通常どおり口調の材料を作ってください（video_notes を「該当区間はありませんでした」という文面そのものに置き換えないでください）。そのうえで、result に portrayal_focus_no_match: true と portrayal_focus_no_match_reason（例: 参考動画に指定の姿・状況の場面がない、といった理由文）を必ず含めてください。当たる区間が見つかった場合は portrayal_focus_no_match を含めないでください。`;
}

// Bias instruction for image_generation: depict that portrayal/situation.
function portrayalImageNote(pf: string): string {
  return `portrayal_focus（演じる姿・状況）として「${pf}」が指定されています。画像はその姿・状況の見た目・雰囲気で生成してください。要素や資料のうち、その姿・状況に当たらない時期・状態の特徴は使わないでください。`;
}

// Premise instruction for acting (switch / profile_apply / trial
// conversation): respond AS that portrayal/situation.
function portrayalActingNote(pf: string): string {
  return `portrayal_focus（演じる姿・状況）として「${pf}」が指定されています。演じる際の前提として、その姿・状況で応答してください（口調・言葉遣い・態度・知識・振る舞いは、その姿・状況に合わせてください）。`;
}

// CR-21: is the bias currently EFFECTIVE? The field must be set AND
// its check state must not be "failed". While failed, the bias is
// treated as inactive everywhere: generation / switch / profile_apply
// / trial payloads carry no portrayal keys and no bias instruction —
// byte-for-byte the payload of a profile that never used the field —
// so content is built from all material as usual. The stored
// portrayal_focus value itself is kept (the user can see what they
// specified, and a later re-check that finds matching material flips
// the state back to "ok" and re-activates the bias).
function portrayalBiasActive(data: ProfileData): boolean {
  return (
    portrayalFocusValue(data) !== null &&
    data.background.portrayal_focus_status !== "failed"
  );
}

// The portrayal value to hand over in payloads / switch output: the
// stored value while the bias is effective, null while it is failed
// (or unused) — null means "no bias" to the chat side.
function portrayalEffectiveValue(data: ProfileData): string | null {
  return portrayalBiasActive(data) ? portrayalFocusValue(data) : null;
}

// Payload fields for material-based generation kinds. Empty object when
// the field is unused OR its bias failed (CR-21), so spreading it
// leaves the payload untouched.
function portrayalGenerationFields(
  data: ProfileData,
): Record<string, string> {
  const pf = portrayalEffectiveValue(data);
  if (!pf) return {};
  return {
    portrayal_focus: pf,
    background_portrayal_focus: pf,
    portrayal_focus_note: portrayalGenerationNote(pf),
  };
}

// Payload fields for acting kinds (profile_apply; switch output uses
// the same value/note pair through its typed schema). Empty object when
// the field is unused OR its bias failed (CR-21).
function portrayalActingFields(data: ProfileData): Record<string, string> {
  const pf = portrayalEffectiveValue(data);
  if (!pf) return {};
  return {
    portrayal_focus: pf,
    background_portrayal_focus: pf,
    portrayal_focus_note: portrayalActingNote(pf),
  };
}

// CR-21: record the outcome of one completed portrayal check
// (link_summary / video_transcript write-back) against the CURRENT
// portrayal_focus value, and re-derive the status:
//   - any completed check found matching material → "ok" (bias on),
//     failure reason cleared;
//   - at least one check completed and ALL of them reported no match
//     → "failed", with the latest no-match reason kept for display;
//   - no check completed yet → "unknown".
// A check only counts while a focus is actually set; write-backs for
// focus-less profiles never touch the state. This never touches the
// preparation state — a failed bias is NOT a preparation failure and
// the profile stays ready/usable.
function recordPortrayalCheck(
  data: ProfileData,
  kind: "link_summary" | "video_transcript",
  result: "match" | "no_match",
  reason: string | null,
): void {
  if (!portrayalFocusValue(data)) return;
  const checks = {
    ...data.background.portrayal_focus_checks,
    [kind]: result,
  };
  const outcomes = [checks.link_summary, checks.video_transcript].filter(
    (v): v is "match" | "no_match" => v !== null,
  );
  let status: "unknown" | "ok" | "failed" =
    data.background.portrayal_focus_status;
  let failureReason = data.background.portrayal_focus_failure_reason;
  if (outcomes.includes("match")) {
    status = "ok";
    failureReason = null;
  } else if (outcomes.length > 0) {
    status = "failed";
    if (result === "no_match") {
      failureReason =
        reason ??
        (kind === "link_summary"
          ? "参考リンクに指定の姿・状況に当たる資料がありませんでした"
          : "参考動画に指定の姿・状況に当たる区間がありませんでした");
    }
  }
  data.background = {
    ...data.background,
    portrayal_focus_checks: checks,
    portrayal_focus_status: status,
    portrayal_focus_failure_reason: failureReason,
  };
}

// CR-21: pull the portrayal verdict out of a generation write-back
// result. The CR-21 contract is portrayal_focus_no_match: true plus
// portrayal_focus_no_match_reason (a human-readable reason). A result
// without the flag means the check found (or used) material normally.
function extractPortrayalVerdict(parsed: Record<string, unknown>): {
  noMatch: boolean;
  reason: string | null;
} {
  if (parsed.portrayal_focus_no_match !== true)
    return { noMatch: false, reason: null };
  const raw =
    typeof parsed.portrayal_focus_no_match_reason === "string"
      ? parsed.portrayal_focus_no_match_reason.trim().slice(0, 1000)
      : "";
  return { noMatch: true, reason: raw || null };
}

// CR-21 (addendum): does this text look like the bare "no matching
// material" notice the pre-CR-21 write-back contract produced — the
// single sentence that once replaced whole summaries / video_notes
// (「指定の姿・状況（…）に当たる資料はありませんでした」)? Used as a
// storage guard: when a write-back reports portrayal_focus_no_match,
// its content fields are supposed to carry the full-material content;
// a content field that is missing, or that is just this notice, must
// never overwrite the stored summary / notes — the stored content is
// kept instead. A long text is never treated as the notice (a real
// full-material summary may mention the miss in passing).
function isPortrayalNoMatchNotice(text: string): boolean {
  const t = text.trim();
  if (t.length > 300) return false;
  return (
    t.includes("に当たる資料はありませんでした") ||
    t.includes("に当たる区間はありませんでした") ||
    (t.includes("指定の姿・状況") && t.includes("ありませんでした"))
  );
}

// CR-21 (addendum 2): when portrayal_focus is REMOVED (set → cleared),
// that save is a repair trigger: alongside the link/video re-queues,
// the profile's avatar_memory is repaired too. The re-queue payloads
// carry the current avatar_memory plus this instruction; the chat side
// returns a repaired avatar_memory in the write-back result ONLY when
// something actually had to be removed (completeGenerationRequest
// applies a returned non-empty avatar_memory for requests whose
// payload carries the avatar_memory_repair marker, and keeps the
// stored memory untouched otherwise — an empty write-back never wipes
// the memory). Saves where portrayal_focus does not actually change
// never carry these fields: no re-queue, no memory repair.
const AVATAR_MEMORY_REPAIR_NOTE =
  "このプロファイルでは「演じる姿・状況」（portrayal_focus）の指定が削除されました。payload の avatar_memory（このプロファイル固有の記憶）に、以前の状況指定に由来して書き込まれた要素（指定の姿・状況を前提とする記述・その前提で生成された内容など）が含まれていれば、それらを取り除き、それ以外の事実経過は保持した avatar_memory を、書き戻し result の avatar_memory として返してください。状況指定に由来する要素が無ければ、avatar_memory は result に含めないでください（その場合は既存のメモリーがそのまま保持されます）。";

function portrayalMemoryRepairFields(
  data: ProfileData,
): Record<string, unknown> {
  return {
    avatar_memory: data.avatar_memory,
    avatar_memory_repair: true,
    avatar_memory_repair_note: AVATAR_MEMORY_REPAIR_NOTE,
  };
}

// Does this generation request's payload carry the CR-21 addendum-2
// memory-repair marker? Only those requests' write-backs may replace
// avatar_memory (and only with a non-empty returned value).
function requestHasMemoryRepair(reqPayload: string): boolean {
  try {
    const p = JSON.parse(reqPayload) as unknown;
    return !!(
      p &&
      typeof p === "object" &&
      !Array.isArray(p) &&
      (p as Record<string, unknown>).avatar_memory_repair === true
    );
  } catch {
    return false;
  }
}

// Extract structured speech fields from a generation write-back result.
// Accepts flat keys (first_person, …), a nested speech / speech_structured
// / speech_fields / structured object, and the common aliases the chat
// side might use.
function extractSpeechUpdates(
  parsed: Record<string, unknown>,
): Partial<Record<SpeechFieldKey, string>> {
  const containers: Record<string, unknown>[] = [parsed];
  for (const key of ["speech", "speech_structured", "speech_fields", "structured"]) {
    const v = parsed[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      containers.push(v as Record<string, unknown>);
    }
  }
  const aliases: Record<SpeechFieldKey, string[]> = {
    first_person: ["first_person", "firstPerson"],
    second_person: ["second_person", "secondPerson"],
    call_user_as: ["call_user_as", "callUserAs", "user_call"],
    catchphrase: ["catchphrase", "catch_phrase", "verbal_tic"],
    memo: ["memo", "speech_memo", "ending_note", "tone_memo"],
    style: ["style", "speech_style"],
  };
  const limits: Record<SpeechFieldKey, number> = {
    first_person: 500,
    second_person: 500,
    call_user_as: 500,
    catchphrase: 1000,
    memo: 2000,
    style: 5000,
  };
  const out: Partial<Record<SpeechFieldKey, string>> = {};
  for (const field of SPEECH_FIELD_KEYS) {
    for (const container of containers) {
      let found: string | null = null;
      for (const alias of aliases[field]) {
        const v = container[alias];
        if (typeof v === "string" && v.trim()) {
          found = v.trim().slice(0, limits[field]);
          break;
        }
      }
      if (found) {
        out[field] = found;
        break;
      }
    }
  }
  return out;
}

// Apply auto-generated speech fields (CR-06): a field whose source is
// "manual" is NEVER overwritten; auto/unset fields take the new value and
// become "auto". Returns the updated data.
function applyAutoSpeechFields(
  data: ProfileData,
  updates: Partial<Record<SpeechFieldKey, string>>,
): ProfileData {
  const structured = { ...data.speech.structured };
  const sources = { ...data.speech.sources };
  let callUserAs = data.call_user_as;
  let style = data.speech.style;
  for (const field of SPEECH_FIELD_KEYS) {
    const value = updates[field];
    if (!value) continue;
    if (sources[field] === "manual") continue;
    if (field === "call_user_as") callUserAs = value;
    else if (field === "style") style = value;
    else structured[field] = value;
    sources[field] = "auto";
  }
  return {
    ...data,
    call_user_as: callUserAs,
    speech: { ...data.speech, style, structured, sources },
  };
}

type FlavorTrait = z.infer<typeof flavorTraitSchema>;

// CR-08: the merged flavor view handed to the chat side in switch /
// profile_apply payloads and generation requests: the user's level plus
// the ENABLED traits only (manual and auto alike — stored traits already
// are the manual-priority merge result, because write-backs never touch
// manual traits). Disabled traits stay on the profile but are excluded
// here, so the chat side never performs them.
// CR-14: each trait also carries frequency (the stored per-trait value,
// null = follows global), effective_frequency (frequency ?? level) and
// frequency_is_custom. Traits whose effective frequency is 0 stay in
// the list with effective_frequency 0 explicitly, so the chat side
// treats them exactly like disabled traits: never show them.
function mergedFlavorView(data: ProfileData) {
  const flavor = data.flavor ?? emptyFlavor;
  return {
    level: flavor.level,
    traits: flavor.traits
      .filter((t) => t.enabled)
      .map((t) => {
        const frequency = t.frequency ?? null;
        const effective = effectiveFlavorFrequency(t, flavor.level);
        return {
          id: t.id,
          label: t.label,
          examples: [...t.examples],
          scenes: [...t.scenes],
          enabled: true,
          source: t.source,
          // CR-12: traits with auto_examples on are improvisation targets
          // for the chat side; once examples are stored they are the model
          // lines to follow. Off traits with no examples stay label-only
          // improvisation, as before.
          auto_examples: t.auto_examples ?? false,
          frequency,
          effective_frequency: effective,
          frequency_is_custom: frequency !== null,
        };
      }),
  };
}

function manualFlavorTraits(data: ProfileData): FlavorTrait[] {
  return (data.flavor ?? emptyFlavor).traits.filter(
    (t) => t.source === "manual",
  );
}

// Extract flavor traits from a generation write-back result (CR-08).
// Accepts {flavor: {traits: [...]}}, {flavor_traits: [...]}, or
// {traits: [...]}, with per-trait aliases (label/name, examples/example/
// example, scenes/scene/triggers, enabled). Everything is truncated to
// the profile schema limits so an over-long write-back cannot make the
// next parseData throw into the all-defaults fallback (D-02 class).
// CR-12: a write-back trait may omit auto_examples; undefined means
// "unspecified" and applyAutoFlavorTraits defaults it to ON, because
// traits arriving through a generation write-back come from the
// full-auto flow (the URL-based initial creation above all).
type ExtractedFlavorTrait = Omit<FlavorTrait, "id" | "source" | "auto_examples" | "frequency"> & {
  auto_examples?: boolean;
  // CR-14: undefined = unspecified in the write-back (defaults to null =
  // follow global when stored); null or 0-5 is an explicit value.
  frequency?: number | null;
};

function extractFlavorTraits(
  parsed: Record<string, unknown>,
): ExtractedFlavorTrait[] {
  let rawList: unknown = null;
  const flavorObj =
    parsed.flavor && typeof parsed.flavor === "object" && !Array.isArray(parsed.flavor)
      ? (parsed.flavor as Record<string, unknown>)
      : null;
  if (flavorObj && Array.isArray(flavorObj.traits)) rawList = flavorObj.traits;
  else if (Array.isArray(parsed.flavor_traits)) rawList = parsed.flavor_traits;
  else if (Array.isArray(parsed.traits)) rawList = parsed.traits;
  if (!Array.isArray(rawList)) return [];
  const out: ExtractedFlavorTrait[] = [];
  for (const item of rawList.slice(0, 50)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const t = item as Record<string, unknown>;
    const labelRaw =
      typeof t.label === "string" ? t.label : typeof t.name === "string" ? t.name : "";
    const label = labelRaw.trim().slice(0, 200);
    if (!label) continue;
    const examplesRaw: unknown[] = Array.isArray(t.examples)
      ? t.examples
      : typeof t.example === "string"
        ? [t.example]
        : typeof t.examples_text === "string"
          ? [t.examples_text]
          : [];
    const examples = examplesRaw
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().slice(0, 1000))
      .filter(Boolean)
      .slice(0, 10);
    const scenesRaw: unknown[] = Array.isArray(t.scenes)
      ? t.scenes
      : Array.isArray(t.scene)
        ? t.scene
        : Array.isArray(t.triggers)
          ? t.triggers
          : typeof t.scene === "string"
            ? [t.scene]
            : [];
    const scenes = scenesRaw
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim().slice(0, 100))
      .filter(Boolean)
      .slice(0, 10);
    // CR-14: per-trait frequency may arrive as frequency or
    // effective_frequency; validate to an integer 0-5, else unspecified.
    const freqRaw =
      typeof t.frequency === "number"
        ? t.frequency
        : typeof t.effective_frequency === "number"
          ? t.effective_frequency
          : t.frequency === null
            ? null
            : undefined;
    const frequency: number | null | undefined =
      freqRaw === null
        ? null
        : typeof freqRaw === "number" && Number.isFinite(freqRaw)
          ? Math.min(5, Math.max(0, Math.round(freqRaw)))
          : undefined;
    out.push({
      label,
      examples,
      scenes,
      enabled: typeof t.enabled === "boolean" ? t.enabled : true,
      auto_examples:
        typeof t.auto_examples === "boolean" ? t.auto_examples : undefined,
      frequency,
    });
  }
  return out;
}

// CR-20: shared merge-rule notes carried in generation payloads. The
// speech note states the CR-18 policy (first unified for
// video_transcript, now applied to link_summary / trial_conversation
// write-backs as well); the flavor note states the CR-20 merge policy.
const SPEECH_MERGE_NOTE =
  "口調の書き戻しはマージ規則（CR-20／CR-18）で反映されます：口癖（catchphrase）はサーバー側で既存の値と和集合マージされます（既存の口癖は消えません。新しい候補だけを返してください）。一人称・二人称（first_person / second_person）は未設定のときだけ埋められ、既に値がある場合は書き戻し側の推定で上書きされません。メモ・口調文（memo / style）を返す場合は、この payload の speech / speech_structured に含まれる既存の口調を土台に、その内容を消さず、統合した文章として返してください（返した文章がそのまま自動項目に反映されます）。manual_speech_fields に挙がった欄はユーザーの手動指定なので変更しないでください（サーバー側でも手動欄への反映は行われません）。";
const FLAVOR_MERGE_NOTE =
  "フレーバーの書き戻しはマージ規則（CR-20）で反映されます：書き戻しに含まれる自動項目は、ラベルが一致する既存の自動項目を土台に更新されます（例文は既存を保持しつつ新しいものを足します。場面・有効/無効・頻度は既存の値を優先し、書き戻し側の値で上書きしません）。ラベルが新しい項目は自動項目として追加されます。書き戻しに含まれなかった既存の自動項目は削除されず、そのまま残ります。manual_flavor_traits に挙がった項目（ユーザーの手動指定）は書き戻しで変更・削除しないでください。フレーバーの量（level）はユーザーのバー設定なので変更しないでください。";

// CR-20 / CR-18: apply auto speech updates with the unified merge
// rules, on top of the CR-06 manual protection (applyAutoSpeechFields
// still guarantees manual fields are never overwritten):
// - catchphrase: UNION merge — stored items are kept and new
//   candidates (the update's catchphrase string split on "／", plus
//   any extra candidates such as a video result's catchphrases[] list)
//   are appended after them, deduplicated by exact match, joined with
//   "／" within the 1000-char schema limit (whole trailing items are
//   dropped rather than cutting one mid-phrase). The stored value is
//   never replaced wholesale.
// - first_person / second_person: single values, never merged — an
//   update is dropped when the field already holds a value (auto or
//   manual); filled only when unset.
// - memo / style / call_user_as: applied as returned — for memo/style
//   the contract (stated in every payload note) is that the returned
//   text is already integrated on top of the existing tone.
function applyMergedAutoSpeechFields(
  data: ProfileData,
  updates: Partial<Record<SpeechFieldKey, string>>,
  extraCatchphraseCandidates: string[] = [],
): ProfileData {
  const merged: Partial<Record<SpeechFieldKey, string>> = { ...updates };
  const candidates: string[] = [];
  for (const c of extraCatchphraseCandidates) {
    if (c && c.trim()) candidates.push(c.trim());
  }
  if (merged.catchphrase) {
    for (const part of merged.catchphrase.split("／")) {
      if (part.trim()) candidates.push(part.trim());
    }
    delete merged.catchphrase;
  }
  if (candidates.length > 0) {
    const existing = (data.speech.structured.catchphrase ?? "")
      .split("／")
      .map((s) => s.trim())
      .filter(Boolean);
    const items = [...existing];
    for (const c of candidates) {
      if (!items.includes(c)) items.push(c);
    }
    let joined = "";
    for (const item of items) {
      const next = joined ? `${joined}／${item}` : item;
      if (next.length > 1000) break;
      joined = next;
    }
    if (joined) merged.catchphrase = joined;
  }
  for (const field of ["first_person", "second_person"] as const) {
    if (merged[field]) {
      const current = data.speech.structured[field];
      if (current && current.trim()) delete merged[field];
    }
  }
  if (Object.keys(merged).length === 0) return data;
  return applyAutoSpeechFields(data, merged);
}

// Apply auto-generated flavor traits (CR-08 + CR-20 MERGE): manual
// traits are kept exactly as they are (never overwritten, never
// removed) and the level never changes. Auto traits are MERGED with
// the write-back instead of being replaced wholesale:
// - an incoming trait whose label matches an existing AUTO trait
//   updates that trait on top of the stored one: examples are
//   union-merged (stored lines kept, new lines appended, deduplicated,
//   capped at the schema limit of 10), while scenes / enabled /
//   frequency / auto_examples keep the STORED values — values the user
//   may have adjusted are never overwritten by a write-back.
// - an incoming trait with a new label is added as a new auto trait
//   (auto_examples defaults ON per CR-12, frequency defaults to null =
//   follow global per CR-14, unless the write-back set them).
// - existing auto traits absent from the write-back are kept as they
//   are — a re-inference can no longer delete them.
// A new auto trait whose label collides with a manual trait is dropped
// (manual wins), exactly as before.
function applyAutoFlavorTraits(
  data: ProfileData,
  incoming: ExtractedFlavorTrait[],
): ProfileData {
  const flavor = data.flavor ?? emptyFlavor;
  const manualLabels = new Set(
    flavor.traits.filter((t) => t.source === "manual").map((t) => t.label),
  );
  const traits: FlavorTrait[] = flavor.traits.map((t) => ({
    ...t,
    examples: [...t.examples],
    scenes: [...t.scenes],
  }));
  let added = 0;
  for (const inc of incoming) {
    if (manualLabels.has(inc.label)) continue;
    const idx = traits.findIndex(
      (t) => t.source === "auto" && t.label === inc.label,
    );
    if (idx >= 0) {
      const existing = traits[idx] as FlavorTrait;
      const examples = [...existing.examples];
      for (const ex of inc.examples) {
        if (!examples.includes(ex)) examples.push(ex);
      }
      traits[idx] = { ...existing, examples: examples.slice(0, 10) };
    } else {
      traits.push({
        id: `ft_auto_${Date.now().toString(36)}_${added++}_${Math.random().toString(36).slice(2, 7)}`,
        label: inc.label,
        examples: [...inc.examples],
        scenes: [...inc.scenes],
        enabled: inc.enabled,
        source: "auto" as const,
        // CR-12: traits born in a generation write-back belong to the
        // full-auto flow, so auto_examples defaults ON unless the
        // write-back explicitly set it.
        auto_examples: inc.auto_examples ?? true,
        // CR-14: auto traits follow the global level unless the
        // write-back explicitly set a per-trait frequency.
        frequency: inc.frequency ?? null,
      });
    }
  }
  return { ...data, flavor: { level: flavor.level, traits } };
}

// ---------------------------------------------------------------------------
// CR-12: flavor example auto-generation (flavor_examples requests)
// ---------------------------------------------------------------------------

// Traits that still need auto-generated examples: auto_examples is on
// and no non-empty example is stored yet.
function flavorExamplesTargets(data: ProfileData): FlavorTrait[] {
  return (data.flavor ?? emptyFlavor).traits.filter(
    (t) =>
      t.auto_examples &&
      t.label.trim() &&
      !t.examples.some((e) => e.trim()),
  );
}

// The payload a flavor_examples request carries: the target traits
// (id / label / scenes) plus the context the chat side needs to write
// in-character example lines — tone, background summary, and the
// user relationship (CR-07).
function buildFlavorExamplesPayload(
  profileName: string,
  data: ProfileData,
  targets: FlavorTrait[],
): string {
  const globalLevel = (data.flavor ?? emptyFlavor).level;
  return JSON.stringify({
    name: profileName,
    targets: targets.map((t) => ({
      id: t.id,
      label: t.label,
      scenes: [...t.scenes],
      // CR-14: per-trait frequency + effective value for this target.
      frequency: t.frequency ?? null,
      effective_frequency: effectiveFlavorFrequency(t, globalLevel),
    })),
    speech_style: data.speech.style,
    speech: mergedSpeechView(data),
    speech_structured: {
      first_person: data.speech.structured.first_person,
      second_person: data.speech.structured.second_person,
      call_user_as: data.call_user_as,
      catchphrase: data.speech.structured.catchphrase,
      memo: data.speech.structured.memo,
    },
    call_user_as: data.call_user_as,
    summary: data.summary,
    background_summary: data.background.link_summary,
    background_text: data.background.text.slice(0, 2000),
    user_relationship: data.background.user_relationship ?? null,
    // CR-19: only when 「演じる姿・状況」 is set — example lines are
    // invented from the matching parts of the material only.
    ...portrayalGenerationFields(data),
    flavor_level: (data.flavor ?? emptyFlavor).level,
    note: "targets の各フレーバー項目について、そのキャラクターの口調・背景・私の扱いに沿った例文を考えてください。書き戻し result は {\"examples_by_trait\": {\"<項目id>\": [\"例文1\", \"例文2\"]}} の形で、項目idごとに例文（複数可）を返してください。例文は保存され、その項目の手本になります。",
  });
}

// Queue (or refresh) the profile's flavor_examples request. At most one
// open request per profile: when one is already pending/processing its
// payload is replaced with the current target set instead of creating a
// duplicate. Returns the request id, or null when nothing needs
// generating.
async function queueFlavorExamplesRequest(
  ctx: Ctx,
  profileId: string,
  profileName: string,
  data: ProfileData,
): Promise<string | null> {
  const targets = flavorExamplesTargets(data);
  if (targets.length === 0) return null;
  const db = ctx.db<typeof schema>();
  const payload = buildFlavorExamplesPayload(profileName, data, targets);
  const open = await db
    .select()
    .from(schema.generationRequests)
    .where(
      and(
        eq(schema.generationRequests.profileId, profileId),
        eq(schema.generationRequests.kind, "flavor_examples"),
      ),
    );
  const existing = open.find(
    (r) => r.status === "pending" || r.status === "processing",
  );
  const now = new Date();
  if (existing) {
    await db
      .update(schema.generationRequests)
      .set({ payload, updatedAt: now })
      .where(eq(schema.generationRequests.id, existing.id));
    return existing.id;
  }
  const id = newId("gen");
  await db.insert(schema.generationRequests).values({
    id,
    profileId,
    kind: "flavor_examples",
    payload,
    status: "pending",
    result: null,
    reason: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

// Extract per-trait example lines from a flavor_examples write-back
// result (CR-12). Accepted shapes: {examples_by_trait: {<id>: [...]}},
// {flavor_examples: {<id>: [...]} or [{id|trait_id, examples}]}, or a
// traits-style array (flavor_traits / traits) whose items carry an id
// matching a stored trait (or a label matching one). Values are
// truncated to the profile schema limits.
function extractFlavorExamples(
  parsed: Record<string, unknown>,
  data: ProfileData,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const traits = (data.flavor ?? emptyFlavor).traits;
  const byId = new Map(traits.map((t) => [t.id, t]));
  const byLabel = new Map(traits.map((t) => [t.label, t]));
  const cleanList = (v: unknown): string[] => {
    const raw: unknown[] = Array.isArray(v)
      ? v
      : typeof v === "string"
        ? [v]
        : [];
    return raw
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().slice(0, 1000))
      .filter(Boolean)
      .slice(0, 10);
  };
  const putMap = (obj: Record<string, unknown>) => {
    for (const [key, v] of Object.entries(obj)) {
      const trait = byId.get(key) ?? byLabel.get(key);
      if (!trait) continue;
      const lines = cleanList(v);
      if (lines.length > 0) out.set(trait.id, lines);
    }
  };
  if (
    parsed.examples_by_trait &&
    typeof parsed.examples_by_trait === "object" &&
    !Array.isArray(parsed.examples_by_trait)
  ) {
    putMap(parsed.examples_by_trait as Record<string, unknown>);
  }
  const fe = parsed.flavor_examples;
  if (fe && typeof fe === "object" && !Array.isArray(fe)) {
    putMap(fe as Record<string, unknown>);
  }
  const lists: unknown[] = [];
  if (Array.isArray(fe)) lists.push(...fe);
  if (Array.isArray(parsed.flavor_traits)) lists.push(...parsed.flavor_traits);
  if (Array.isArray(parsed.traits)) lists.push(...parsed.traits);
  const flavorObj =
    parsed.flavor && typeof parsed.flavor === "object" && !Array.isArray(parsed.flavor)
      ? (parsed.flavor as Record<string, unknown>)
      : null;
  if (flavorObj && Array.isArray(flavorObj.traits)) lists.push(...flavorObj.traits);
  for (const item of lists) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const t = item as Record<string, unknown>;
    const idRaw = typeof t.id === "string" ? t.id : typeof t.trait_id === "string" ? t.trait_id : "";
    const labelRaw = typeof t.label === "string" ? t.label : typeof t.name === "string" ? t.name : "";
    const trait =
      (idRaw ? byId.get(idRaw) : undefined) ??
      (labelRaw.trim() ? byLabel.get(labelRaw.trim()) : undefined);
    if (!trait || out.has(trait.id)) continue;
    const lines = cleanList(t.examples ?? t.example);
    if (lines.length > 0) out.set(trait.id, lines);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CR-17: 参考動画の文字起こし (video_transcript requests)
// ---------------------------------------------------------------------------

function normalizeVideoUrls(list: string[] | undefined): string[] {
  return (list ?? []).map((u) => u.trim()).filter(Boolean);
}

// Video URLs of the profile that no video_transcript attempt has covered
// yet — the ones that make a save queue (or refresh) a request.
function unprocessedVideoUrls(data: ProfileData): string[] {
  const processed = new Set(
    normalizeVideoUrls(data.background.video_processed_urls),
  );
  return normalizeVideoUrls(data.background.video_urls).filter(
    (u) => !processed.has(u),
  );
}

// The payload a video_transcript request carries: the video URLs plus
// the context the chat side needs to mine the dialogue for tone — the
// character name, the background summary, and the speech fields as
// currently known (with the manual ones flagged as untouchable).
function buildVideoTranscriptPayload(
  profileName: string,
  data: ProfileData,
  unprocessed: string[],
  opts: { memoryRepair?: boolean } = {},
): string {
  // CR-21: while the bias is failed it is inactive — the payload then
  // carries no portrayal keys, exactly like an unused field.
  const pf = portrayalEffectiveValue(data);
  return JSON.stringify({
    name: profileName,
    video_urls: normalizeVideoUrls(data.background.video_urls),
    unprocessed_video_urls: unprocessed,
    background_summary: data.background.link_summary,
    background_text: data.background.text.slice(0, 2000),
    summary: data.summary,
    user_relationship: data.background.user_relationship ?? null,
    // CR-21 addendum 2: only when this queueing is the repair re-queue
    // of a portrayal_focus removal — the current avatar_memory plus
    // the instruction to strip specification-derived elements from it
    // and return the repaired text in the write-back.
    ...(opts.memoryRepair ? portrayalMemoryRepairFields(data) : {}),
    // CR-19: only when 「演じる姿・状況」 is set — the transcript work
    // is restricted to the chapters/segments matching that portrayal.
    ...(pf
      ? {
          portrayal_focus: pf,
          background_portrayal_focus: pf,
          portrayal_focus_note: portrayalVideoNote(pf),
        }
      : {}),
    speech: mergedSpeechView(data),
    speech_structured: {
      first_person: data.speech.structured.first_person,
      second_person: data.speech.structured.second_person,
      call_user_as: data.call_user_as,
      catchphrase: data.speech.structured.catchphrase,
      memo: data.speech.structured.memo,
    },
    speech_sources: { ...data.speech.sources },
    manual_speech_fields: manualSpeechFields(data),
    existing_video_notes: data.background.video_notes ?? null,
    // CR-20: the current flavor setting travels with the request (auto
    // and manual traits distinguished) so flavor can be re-inferred
    // from the videos' dialogue too; the write-back may carry
    // flavor_traits and it is applied with the CR-20 merge rules.
    flavor: mergedFlavorView(data),
    flavor_level: (data.flavor ?? emptyFlavor).level,
    flavor_traits: (data.flavor ?? emptyFlavor).traits.map((t) => ({
      ...t,
      examples: [...t.examples],
      scenes: [...t.scenes],
      frequency: t.frequency ?? null,
      effective_frequency: effectiveFlavorFrequency(
        t,
        (data.flavor ?? emptyFlavor).level,
      ),
    })),
    manual_flavor_traits: manualFlavorTraits(data).map((t) => ({
      label: t.label,
      examples: [...t.examples],
      scenes: [...t.scenes],
      frequency: t.frequency ?? null,
      effective_frequency: effectiveFlavorFrequency(
        t,
        (data.flavor ?? emptyFlavor).level,
      ),
    })),
    flavor_note: FLAVOR_MERGE_NOTE,
    note: "video_urls は参考動画です。各動画の文字起こし（字幕／トランスクリプト）だけを取得してください。動画を再生・視聴する必要はありません。文字起こしは自動音声認識のことが多く誤認識を含みます。明らかな誤りは文脈で補正し、台詞をそのままの引用としてではなく、口癖・語尾・一人称／二人称など口調の材料として読んでください。話者の区切りが字幕にない場合は場面から推定してください。書き戻し result は {\"video_notes\": \"台詞から読み取れた口調の特徴の要約\", \"catchphrases\": [\"決まり文句・口癖の候補\", ...], \"unreadable_videos\": [\"文字起こしを取得できなかったURL\", ...]} の形で返してください。あわせて推定できた口調があれば first_person / second_person / memo / style などのキー（または speech オブジェクト）で含めて構いません。台詞から推定できるフレーバー項目があれば、result の flavor_traits（または flavor.traits）に {label, examples[], scenes[], enabled} の形で含めてください（フレーバーの反映は flavor_note のマージ規則どおりです）。取得できなかった動画は理由とともに unreadable_videos に入れてください（例: \"URL（字幕なし）\"）。manual_speech_fields に挙がった口調欄はユーザーの手動指定なので変更しないでください（サーバー側でも手動欄への反映は行われません）。口調の書き戻しはマージ規則（CR-18／CR-20）で反映されます：catchphrases（口癖）はサーバー側で既存の値と和集合マージされます（既存の口癖は消えません。新しい候補だけを返してください）。first_person / second_person は未設定のときだけ反映され、既に値がある場合は動画側の推定で上書きされません。memo / style を返す場合は、この payload の speech / speech_structured に含まれる既存の口調を土台に、その内容を消さず、動画の知見を統合した文章として返してください（返した文章がそのまま自動項目に反映されます）。",
  });
}

// Queue (or refresh) the profile's video_transcript request. At most
// one open request per profile: when one is already pending/processing
// its payload is replaced with the current URL set and context instead
// of creating a duplicate. Without `force`, only URLs no attempt has
// covered yet trigger a request (a failed attempt's URLs stay attempted
// so an unrelated save never silently clears the failure); with
// `force` (manual retry via createGenerationRequest) every current URL
// is re-queued. Queueing flips the profile's video preparation hint to
// pending and clears its failure reason. Returns the request id, or
// null when there is nothing to process.
async function queueVideoTranscriptRequest(
  ctx: Ctx,
  profileId: string,
  profileName: string,
  data: ProfileData,
  opts: { force?: boolean; memoryRepair?: boolean } = {},
): Promise<string | null> {
  const urls = normalizeVideoUrls(data.background.video_urls);
  if (urls.length === 0) return null;
  const unprocessed = opts.force ? urls : unprocessedVideoUrls(data);
  if (unprocessed.length === 0) return null;
  const db = ctx.db<typeof schema>();
  const payload = buildVideoTranscriptPayload(profileName, data, unprocessed, {
    memoryRepair: opts.memoryRepair,
  });
  const open = await db
    .select()
    .from(schema.generationRequests)
    .where(
      and(
        eq(schema.generationRequests.profileId, profileId),
        eq(schema.generationRequests.kind, "video_transcript"),
      ),
    );
  const existing = open.find(
    (r) => r.status === "pending" || r.status === "processing",
  );
  const now = new Date();
  let requestId: string;
  if (existing) {
    await db
      .update(schema.generationRequests)
      .set({ payload, updatedAt: now })
      .where(eq(schema.generationRequests.id, existing.id));
    requestId = existing.id;
  } else {
    requestId = newId("gen");
    await db.insert(schema.generationRequests).values({
      id: requestId,
      profileId,
      kind: "video_transcript",
      payload,
      status: "pending",
      result: null,
      reason: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  // A (re)queued attempt means the video item is 処理中 again: flip the
  // stored hint to pending and clear the previous failure reason (the
  // D-03 retry path, same as createGenerationRequest for other kinds).
  const profRows = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.id, profileId))
    .limit(1);
  if (profRows[0] && !profRows[0].deletedAt) {
    const current = parseData(profRows[0].data);
    if (
      current.preparation.video !== "pending" ||
      current.preparation_errors.video !== null
    ) {
      current.preparation = { ...current.preparation, video: "pending" };
      current.preparation_errors = {
        ...current.preparation_errors,
        video: null,
      };
      await db
        .update(schema.profiles)
        .set({
          data: JSON.stringify(withPreparation(current)),
          updatedAt: now,
        })
        .where(eq(schema.profiles.id, profileId));
    }
  }
  return requestId;
}

// CR-10 read/write normalization: an invalid color falls back to the
// default; a profile still at the default source gets its initial theme
// color inferred from the appearance elements (existing profiles are
// initialized this way without any other field changing). Auto colors
// acquired from an image and manual colors are left exactly as stored.
function normalizeThemeColor(data: ProfileData): ProfileData {
  let color = data.theme_color;
  let source = data.theme_color_source ?? "default";
  if (!isValidThemeColor(color)) {
    color = DEFAULT_THEME_COLOR;
    if (source === "manual") source = "default";
  }
  color = color.toLowerCase();
  if (source === "default") {
    const inferred = inferThemeColorFromElements(data.image_base.elements);
    if (inferred) {
      return { ...data, theme_color: inferred, theme_color_source: "auto" };
    }
    if (color === data.theme_color && source === data.theme_color_source)
      return data;
    return { ...data, theme_color: DEFAULT_THEME_COLOR, theme_color_source: "default" };
  }
  if (color === data.theme_color && source === data.theme_color_source)
    return data;
  return { ...data, theme_color: color, theme_color_source: source };
}

function withPreparation(data: ProfileData): ProfileData {
  data = normalizeThemeColor(normalizeSpeechSources(data));
  const preparation = calcPreparation(data);
  // Errors only make sense while the item is failed; clear them otherwise.
  const errors = { ...data.preparation_errors };
  if (preparation.image !== "failed") errors.image = null;
  if (preparation.link_summary !== "failed") errors.link_summary = null;
  if (preparation.greeting !== "failed") errors.greeting = null;
  if (preparation.video !== "failed") errors.video = null;
  return { ...data, preparation, preparation_errors: errors };
}

// R-01 recovery: profiles hit by D-02 lost their `images` list while
// `image_base.image_ref` still points at the real image (an http(s) URL or
// an owned blob key under avatars/). Rebuild the single primary entry from
// the reference so the card/detail render again. Plain workspace/asset
// paths are reference-only records (the file lives chat-side) and are left
// alone — inventing a blob entry for them would break the blob URL lookup.
function recoverImages(data: ProfileData): ProfileData {
  if (data.images.length > 0) return data;
  const ref = data.image_base.image_ref;
  if (!ref || data.image_base.type !== "image") return data;
  let hash = 0;
  for (let i = 0; i < ref.length; i++) hash = (hash * 31 + ref.charCodeAt(i)) | 0;
  const id = `im_recovered_${Math.abs(hash).toString(36)}`;
  if (/^https?:\/\//.test(ref)) {
    return {
      ...data,
      images: [{ id, file: ref, blob_key: null, is_primary: true, source: "url" }],
    };
  }
  if (ref.startsWith("avatars/")) {
    return {
      ...data,
      images: [{ id, file: ref, blob_key: ref, is_primary: true, source: "upload" }],
    };
  }
  return data;
}

// D-02 / R-01 / R-12 partial-update merge: fields that are managed outside
// the plain edit form (image list, generation results) must survive an
// update whose payload did not carry them. `before` is the stored profile,
// `incoming` is what the caller sent. A field is preserved when the
// incoming value is empty/absent and the stored value is not — unless the
// caller explicitly lists the field in `allowClear` (e.g. the detail UI's
// 固有の記憶リセット）. Image removal itself goes through removeImage, and
// switching the image base to none/elements is an explicit type change, so
// neither is blocked by this merge.
//
// image_base gets the strongest protection (phase-6 leftover defect): a
// rename-only payload built from schema defaults carries
// `image_base: { type: "none", image_ref: null, elements: <all defaults> }`
// because zod fills every omitted element key with its default — that stub
// must never overwrite a stored base. Short of a stub, element values are
// preserved per key (an empty incoming key keeps the stored value), and
// image_ref is preserved whenever the payload leaves it empty. Only an
// allowClear entry ("image_base" for the whole base, "elements" for all
// element keys, "elements:<key>" for one key, "image_ref" for the
// reference) or a non-stub payload that actually carries new values may
// change the base.
function elementsAreStub(
  elements: ProfileData["image_base"]["elements"],
): boolean {
  return ELEMENT_KEYS.every(
    (k) => !elements[k] || (k === "背景" && elements[k] === "白（固定）"),
  );
}

function mergePreservingManagedFields(
  before: ProfileData,
  incoming: ProfileData,
  allowClear: string[] = [],
): ProfileData {
  const out: ProfileData = { ...incoming };
  const beforeRecovered = recoverImages(before);
  if (!allowClear.includes("images") && out.images.length === 0 && beforeRecovered.images.length > 0) {
    out.images = beforeRecovered.images.map((img) => ({ ...img }));
  }
  // --- image_base: type / image_ref / elements (all 13 keys) ---
  if (!allowClear.includes("image_base")) {
    const inBase = out.image_base;
    const beforeBase = before.image_base;
    const elements: ProfileData["image_base"]["elements"] = {
      ...inBase.elements,
    };
    if (!allowClear.includes("elements")) {
      for (const key of ELEMENT_KEYS) {
        if (
          !elements[key] &&
          beforeBase.elements[key] &&
          !allowClear.includes(`elements:${key}`)
        ) {
          elements[key] = beforeBase.elements[key];
        }
      }
    }
    const incomingIsStub =
      inBase.type === "none" &&
      !inBase.image_ref &&
      elementsAreStub(inBase.elements);
    const beforeIsStub =
      beforeBase.type === "none" &&
      !beforeBase.image_ref &&
      elementsAreStub(beforeBase.elements);
    if (
      incomingIsStub &&
      !beforeIsStub &&
      !allowClear.includes("image_ref") &&
      !allowClear.includes("images")
    ) {
      // The payload never carried image_base at all (a scratch/default
      // payload): keep the stored base exactly as it is.
      out.image_base = {
        type: beforeBase.type,
        image_ref: beforeBase.image_ref,
        elements: { ...beforeBase.elements },
      };
    } else {
      out.image_base = {
        type: inBase.type,
        image_ref:
          inBase.image_ref ??
          (inBase.type !== "none" && !allowClear.includes("image_ref")
            ? beforeBase.image_ref
            : null),
        elements,
      };
    }
  }
  if (!allowClear.includes("greeting") && !out.greeting.trim() && before.greeting.trim()) {
    out.greeting = before.greeting;
  }
  // Plain text fields follow the same preserve-on-empty rule: a payload
  // that never carried them (agent-side rename-only updates) must not wipe
  // them; the UI passes allowClear for fields the user emptied on purpose.
  if (!allowClear.includes("summary") && !out.summary && before.summary) {
    out.summary = before.summary;
  }
  if (
    !allowClear.includes("background_text") &&
    !out.background.text &&
    before.background.text
  ) {
    out.background = { ...out.background, text: before.background.text };
  }
  // CR-07: 「私の扱い」 follows the same preserve-on-empty rule — a
  // payload that never carried it must not wipe it; the UI lists
  // "user_relationship" in allow_clear when the user emptied it on
  // purpose. Generation write-backs never touch this field at all
  // (completeGenerationRequest is field-scoped), so it also survives
  // link_summary / trial_conversation / image_generation results.
  if (
    !allowClear.includes("user_relationship") &&
    !allowClear.includes("background_user_relationship") &&
    !out.background.user_relationship &&
    before.background.user_relationship
  ) {
    out.background = {
      ...out.background,
      user_relationship: before.background.user_relationship,
    };
  }
  // CR-19: 「演じる姿・状況」 follows the same preserve-on-empty rule —
  // a payload that never carried it must not wipe it; the UI lists
  // "portrayal_focus" in allow_clear when the user emptied it on
  // purpose. Generation write-backs never touch this field at all
  // (completeGenerationRequest is field-scoped).
  if (
    !allowClear.includes("portrayal_focus") &&
    !allowClear.includes("background_portrayal_focus") &&
    !out.background.portrayal_focus &&
    before.background.portrayal_focus
  ) {
    out.background = {
      ...out.background,
      portrayal_focus: before.background.portrayal_focus,
    };
  }
  // CR-21: the portrayal check state (status / failure reason / per-kind
  // check outcomes) is generation-managed — it is written only by
  // completeGenerationRequest verdicts and by updateProfile's reset
  // when portrayal_focus itself changes. A form or stub payload carries
  // only schema defaults for it, so the stored state always wins here;
  // updateProfile applies the reset AFTER this merge when the focus
  // value actually changed.
  out.background = {
    ...out.background,
    portrayal_focus_status: before.background.portrayal_focus_status,
    portrayal_focus_failure_reason:
      before.background.portrayal_focus_failure_reason,
    portrayal_focus_checks: { ...before.background.portrayal_focus_checks },
  };
  const linksOf = (d: ProfileData) => d.background.links.map((l) => l.trim()).filter(Boolean);
  if (
    !allowClear.includes("links") &&
    linksOf(out).length === 0 &&
    linksOf(before).length > 0
  ) {
    out.background = { ...out.background, links: [...before.background.links] };
  }
  // CR-17: 参考動画URL follows the same preserve-on-empty rule as the
  // reference links — a payload that never carried them must not wipe
  // them; the UI lists "video_urls" in allow_clear when the user
  // removed every URL on purpose.
  if (
    !allowClear.includes("video_urls") &&
    normalizeVideoUrls(out.background.video_urls).length === 0 &&
    normalizeVideoUrls(before.background.video_urls).length > 0
  ) {
    out.background = {
      ...out.background,
      video_urls: [...before.background.video_urls],
    };
  }
  // CR-06 speech fields (structured fields + call_user_as + style):
  // preserve-on-empty per field, plus source-flag resolution. The
  // incoming values/sources are captured BEFORE preservation so the
  // resolver can tell "payload never carried the field" (keep stored
  // value and source) from "payload carried a value" (payload's recorded
  // source wins; a changed value with no recorded source becomes
  // "manual" — a user edit outranks auto generation). allow_clear
  // entries ("speech_first_person", "speech_second_person",
  // "speech_catchphrase", "speech_memo", "call_user_as", "speech_style")
  // clear value+source intentionally.
  {
    const inStructured = { ...out.speech.structured };
    const inSources = { ...out.speech.sources };
    const inCall = out.call_user_as;
    const inStyle = out.speech.style;
    const structured = { ...inStructured };
    const sources = { ...inSources };
    const resolve = (
      key: SpeechFieldKey,
      clearName: string,
      inValue: string | null,
      beforeValue: string | null,
    ): string | null => {
      let finalValue = inValue;
      if (!allowClear.includes(clearName) && !finalValue && beforeValue) {
        finalValue = beforeValue;
      }
      if (!finalValue) {
        sources[key] = null;
        return null;
      }
      if (allowClear.includes(clearName)) {
        // Intentional replace/clear path: keep the payload's own source
        // (the form records "manual" for typed values).
        sources[key] = inValue ? (inSources[key] ?? "manual") : null;
        return finalValue;
      }
      if (inValue) {
        const inSrc = inSources[key];
        if (inValue !== beforeValue) {
          // A changed value arriving through an update is a user edit:
          // it becomes "manual" unless the payload recorded a *different*
          // source than the stored one (the form's live source state, or
          // a history snapshot being restored).
          sources[key] =
            inSrc && inSrc !== before.speech.sources[key] ? inSrc : "manual";
        } else {
          sources[key] = inSrc ?? before.speech.sources[key];
        }
      } else {
        // Preserved from stored: the stored source stands.
        sources[key] = before.speech.sources[key];
      }
      return finalValue;
    };
    for (const key of ["first_person", "second_person", "catchphrase", "memo"] as const) {
      const clearName = `speech_${key}`;
      structured[key] = resolve(
        key,
        clearName,
        inStructured[key],
        before.speech.structured[key],
      );
    }
    out.call_user_as = resolve(
      "call_user_as",
      "call_user_as",
      inCall,
      before.call_user_as,
    );
    const finalStyle = resolve("style", "speech_style", inStyle, before.speech.style);
    out.speech = { ...out.speech, style: finalStyle, structured, sources };
  }
  // CR-10 theme color: a manual color is never overwritten by an
  // automatic/default payload (image replacement and agent-side stub
  // updates included); a default-stub payload never overwrites a stored
  // auto/manual color. The detail UI lists "theme_color" in allow_clear
  // when the user changed the color or returned it to automatic on
  // purpose, which is the only way a manual color gets replaced through
  // this merge.
  if (!allowClear.includes("theme_color")) {
    const beforeColor = before.theme_color;
    const beforeSource = before.theme_color_source ?? "default";
    const inColor = out.theme_color;
    const inSource = out.theme_color_source ?? "default";
    const incomingIsStub =
      inSource === "default" &&
      typeof inColor === "string" &&
      inColor.toLowerCase() === DEFAULT_THEME_COLOR;
    const beforeIsStub =
      beforeSource === "default" &&
      typeof beforeColor === "string" &&
      beforeColor.toLowerCase() === DEFAULT_THEME_COLOR;
    if (beforeSource === "manual" && inSource !== "manual") {
      out.theme_color = beforeColor;
      out.theme_color_source = "manual";
    } else if (incomingIsStub && !beforeIsStub) {
      out.theme_color = beforeColor;
      out.theme_color_source = beforeSource;
    }
  }
  // CR-08 flavor: preserve-on-empty plus per-trait source resolution,
  // mirroring the CR-06 speech rules. A payload that carries no traits
  // (a scratch/default payload, or the form before this feature existed)
  // keeps the stored flavor entirely — level included — unless the
  // caller lists "flavor" / "flavor_traits" in allow_clear (the UI does
  // when the user deletes every trait on purpose). Otherwise each
  // incoming trait is resolved: unchanged content keeps the payload's
  // recorded source (the form carries stored sources through), while a
  // new or changed trait arriving through this user-edit path becomes
  // "manual" so generation write-backs can never overwrite it.
  if (!allowClear.includes("flavor") && !allowClear.includes("flavor_traits")) {
    const inFlavor = out.flavor ?? emptyFlavor;
    const beforeFlavor = before.flavor ?? emptyFlavor;
    if (inFlavor.traits.length === 0 && beforeFlavor.traits.length > 0) {
      out.flavor = {
        level: beforeFlavor.level,
        traits: beforeFlavor.traits.map((t) => ({
          ...t,
          examples: [...t.examples],
          scenes: [...t.scenes],
        })),
      };
    } else {
      const beforeById = new Map(beforeFlavor.traits.map((t) => [t.id, t]));
      const traits = inFlavor.traits.map((t) => {
        const prev =
          beforeById.get(t.id) ??
          beforeFlavor.traits.find((b) => b.label === t.label);
        const sameContent =
          prev != null &&
          prev.label === t.label &&
          prev.enabled === t.enabled &&
          // CR-12: toggling 「例文を自動作成」 is a user edit too.
          (prev.auto_examples ?? false) === (t.auto_examples ?? false) &&
          // CR-14: changing the per-trait frequency (including returning
          // it to null = follow global) is a user edit too.
          (prev.frequency ?? null) === (t.frequency ?? null) &&
          JSON.stringify(prev.examples) === JSON.stringify(t.examples) &&
          JSON.stringify(prev.scenes) === JSON.stringify(t.scenes);
        return {
          ...t,
          examples: [...t.examples],
          scenes: [...t.scenes],
          source: (sameContent ? t.source : "manual") as "auto" | "manual",
        };
      });
      out.flavor = { level: inFlavor.level, traits };
    }
  }
  if (!allowClear.includes("voice_kind") && !out.voice.kind && before.voice.kind) {
    out.voice = { ...out.voice, kind: before.voice.kind };
  }
  if (!allowClear.includes("voice_speed") && !out.voice.speed && before.voice.speed) {
    out.voice = { ...out.voice, speed: before.voice.speed };
  }
  // Origin is metadata the edit form only carries through; a default stub
  // ({type:"app", chat_link:null}) must not erase an imported/auto-saved
  // provenance.
  if (
    out.origin.type === "app" &&
    !out.origin.chat_link &&
    (before.origin.type !== "app" || before.origin.chat_link)
  ) {
    out.origin = { ...before.origin };
  }
  const sameLinks =
    linksOf(out).length === linksOf(before).length &&
    linksOf(out).every((l, i) => l === linksOf(before)[i]);
  if (
    !allowClear.includes("link_summary") &&
    sameLinks &&
    !out.background.link_summary &&
    before.background.link_summary
  ) {
    out.background = { ...out.background, link_summary: before.background.link_summary };
  }
  if (
    !allowClear.includes("unreadable_links") &&
    sameLinks &&
    out.background.unreadable_links.length === 0 &&
    before.background.unreadable_links.length > 0
  ) {
    out.background = {
      ...out.background,
      unreadable_links: [...before.background.unreadable_links],
    };
  }
  // CR-17: the video generation results (video_notes / unreadable_videos
  // / video_processed_urls) are managed by video_transcript write-backs,
  // like link_summary: a payload that leaves them empty keeps the stored
  // values, so a rename-only edit can never wipe the transcript findings.
  // (The edit form carries them through from the stored profile anyway.)
  if (
    !allowClear.includes("video_notes") &&
    !out.background.video_notes &&
    before.background.video_notes
  ) {
    out.background = {
      ...out.background,
      video_notes: before.background.video_notes,
    };
  }
  if (
    out.background.unreadable_videos.length === 0 &&
    before.background.unreadable_videos.length > 0
  ) {
    out.background = {
      ...out.background,
      unreadable_videos: [...before.background.unreadable_videos],
    };
  }
  if (
    out.background.video_processed_urls.length === 0 &&
    before.background.video_processed_urls.length > 0
  ) {
    out.background = {
      ...out.background,
      video_processed_urls: [...before.background.video_processed_urls],
    };
  }
  if (!allowClear.includes("avatar_memory") && !out.avatar_memory && before.avatar_memory) {
    // Only preserve when the caller did not touch the field at all is
    // indistinguishable from an intentional clear at this layer; the UI's
    // explicit reset passes allowClear, and agent-side scratch payloads
    // (the D-02 accident shape) send "" — preserving is the safer default
    // for a memory field. Intentional clears use allowClear.
    out.avatar_memory = before.avatar_memory;
  }
  if (!out.candidate_id && before.candidate_id) {
    out.candidate_id = before.candidate_id;
  }
  return out;
}

const profileOutSchema = z.object({
  format: z.literal("avatar-profile"),
  format_version: z.literal("1.0"),
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  greeting: z.string(),
  preparation: preparationSchema,
  preparation_errors: preparationErrorsSchema,
  background: profileDataSchema.shape.background,
  images: z.array(
    imageEntrySchema.extend({ url: z.string().nullable().default(null) }),
  ),
  image_base: profileDataSchema.shape.image_base,
  call_user_as: z.string().nullable(),
  speech: profileDataSchema.shape.speech,
  flavor: profileDataSchema.shape.flavor,
  theme_color: z.string(),
  theme_color_source: themeColorSourceSchema,
  voice: profileDataSchema.shape.voice,
  avatar_memory: z.string(),
  switch_settings: profileDataSchema.shape.switch_settings,
  origin: profileDataSchema.shape.origin,
  candidate_id: z.string().nullable(),
  favorite: z.boolean(),
  is_active: z.boolean(),
  is_default: z.boolean(),
  // CR-03: open (pending/processing) requests targeting this profile, so
  // the list and detail can show a clear 反映待ち badge.
  pending_switch_count: z.number(),
  pending_apply_count: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  last_used_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
});

type ProfileRow = typeof schema.profiles.$inferSelect;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function parseData(raw: string): ProfileData {
  try {
    const parsed = profileDataSchema.parse(JSON.parse(raw));
    // Re-derive preparation for legacy rows that had no preparation /
    // greeting, and recover an images list lost to D-02 from image_ref.
    return withPreparation(recoverImages(parsed));
  } catch {
    const fallback = profileDataSchema.parse({
      summary: "",
      greeting: "",
      preparation: { image: "none", link_summary: "none", greeting: "pending", video: "none", status: "preparing" },
      background: { text: "", links: [], link_summary: null, unreadable_links: [], video_urls: [], video_notes: null, unreadable_videos: [], video_processed_urls: [] },
      images: [],
      image_base: { type: "none", image_ref: null, elements: {} },
      call_user_as: null,
      speech: { style: null, inferred: false, tuning: {} },
      flavor: { level: 3, traits: [] },
      voice: { reserved: true, kind: null, speed: null },
      avatar_memory: "",
      switch_settings: { pass_conversation_summary: false, use_shared_info: true },
      origin: { type: "app", chat_link: null },
      candidate_id: null,
    });
    return withPreparation(fallback);
  }
}

async function toProfileOut(
  ctx: Ctx,
  row: ProfileRow,
): Promise<z.infer<typeof profileOutSchema>> {
  const data = parseData(row.data);
  const db = ctx.db<typeof schema>();
  const swRows = await db
    .select({ status: schema.switchRequests.status })
    .from(schema.switchRequests)
    .where(eq(schema.switchRequests.profileId, row.id));
  const pending_switch_count = swRows.filter(
    (r) => r.status === "pending" || r.status === "processing",
  ).length;
  const genRows = await db
    .select({ status: schema.generationRequests.status })
    .from(schema.generationRequests)
    .where(
      and(
        eq(schema.generationRequests.profileId, row.id),
        eq(schema.generationRequests.kind, "profile_apply"),
      ),
    );
  const pending_apply_count = genRows.filter(
    (r) => r.status === "pending" || r.status === "processing",
  ).length;
  const images = await Promise.all(
    data.images.map(async (img) => {
      // A missing blob (e.g. an image_ref recovered after D-02 whose blob
      // is gone) must not take the whole profile read down with it.
      let url: string | null = null;
      if (img.blob_key) {
        try {
          url = await ctx.blobs.getUrl(img.blob_key);
        } catch {
          url = null;
        }
      }
      return { ...img, url };
    }),
  );
  return {
    format: "avatar-profile",
    format_version: "1.0",
    id: row.id,
    name: row.name,
    summary: data.summary,
    greeting: data.greeting ?? "",
    preparation: data.preparation,
    preparation_errors: data.preparation_errors,
    background: data.background,
    images,
    image_base: data.image_base,
    call_user_as: data.call_user_as,
    speech: data.speech,
    flavor: data.flavor ?? emptyFlavor,
    theme_color: data.theme_color ?? DEFAULT_THEME_COLOR,
    theme_color_source: data.theme_color_source ?? "default",
    voice: data.voice,
    avatar_memory: data.avatar_memory,
    switch_settings: {
      pass_conversation_summary: false,
      use_shared_info: data.switch_settings.use_shared_info,
    },
    origin: data.origin,
    candidate_id: data.candidate_id,
    favorite: row.favorite,
    is_active: row.isActive,
    is_default: row.isDefault,
    pending_switch_count,
    pending_apply_count,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

async function pushHistory(
  ctx: Ctx,
  row: ProfileRow,
  label: string,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const snapshot = JSON.stringify({
    name: row.name,
    favorite: row.favorite,
    data: parseData(row.data),
  });
  await db.insert(schema.profileHistory).values({
    profileId: row.id,
    snapshot,
    label,
    createdAt: new Date(),
  });
  const versions = await db
    .select({ id: schema.profileHistory.id })
    .from(schema.profileHistory)
    .where(eq(schema.profileHistory.profileId, row.id))
    .orderBy(desc(schema.profileHistory.id));
  const extra = versions.slice(20);
  for (const v of extra) {
    await db
      .delete(schema.profileHistory)
      .where(eq(schema.profileHistory.id, v.id));
  }
}

async function getRow(ctx: Ctx, id: string): Promise<ProfileRow> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("プロファイルが見つかりません。");
  return row;
}

const switchRequestOut = z.object({
  id: z.string(),
  profile_id: z.string(),
  profile_name: z.string(),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  reason: z.string().nullable(),
  phrase: z.string(),
  // CR-07: the target profile's 「私の扱い」, carried on the switch
  // request itself so the chat side can read it as the basis for how to
  // treat the user after the switch (distance/attitude, not just the
  // name they are called by). Null when unspecified.
  user_relationship: z.string().nullable(),
  // CR-19: the target profile's 「演じる姿・状況」 (portrayal_focus) and
  // its acting instruction. Both are null when the field is unused —
  // null means NO bias: the chat side acts exactly as before. When set,
  // portrayal_focus_note instructs the chat side to respond in that
  // portrayal/situation after the switch.
  portrayal_focus: z.string().nullable(),
  portrayal_focus_note: z.string().nullable(),
  // CR-08: the target profile's merged flavor setting — the user's
  // level plus the ENABLED traits only (manual-priority merge result).
  // The chat side performs flavor according to this after the switch;
  // disabled traits are excluded.
  // CR-14: each trait carries frequency / effective_frequency /
  // frequency_is_custom (see mergedFlavorView).
  flavor: mergedFlavorSchema,
  // CR-17: what the reference videos' dialogue revealed about the
  // character's tone (background.video_notes), handed over as tone
  // reference material for the conversation after the switch. Null
  // when no video transcript has been processed.
  video_notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

type SwitchRow = typeof schema.switchRequests.$inferSelect;

function switchPhrase(profileName: string, requestId: string): string {
  return `アバター総合管理で「${profileName}」への切替リクエストを作成しました（リクエストID: ${requestId}）。切替を処理してください。`;
}

// CR-04: profile_apply requests get a canned phrase in the same format as
// switch requests. The user pastes it into chat; that paste is the formal
// trigger for the chat-side agent to apply the update.
function applyPhrase(profileName: string, requestId: string): string {
  return `アバター総合管理で「${profileName}」のプロファイル更新の即時反映リクエストを作成しました（リクエストID: ${requestId}）。反映を処理してください。`;
}

async function toSwitchOut(
  ctx: Ctx,
  row: SwitchRow,
): Promise<z.infer<typeof switchRequestOut>> {
  const db = ctx.db<typeof schema>();
  const profs = await db
    .select({ name: schema.profiles.name, data: schema.profiles.data })
    .from(schema.profiles)
    .where(eq(schema.profiles.id, row.profileId))
    .limit(1);
  const name = profs[0]?.name ?? "(削除済み)";
  const profData = profs[0] ? parseData(profs[0].data) : null;
  const userRelationship = profData
    ? (profData.background.user_relationship ?? null)
    : null;
  // CR-21: a failed bias is inactive — the switch output then reports
  // null/null (no bias), exactly like a profile not using the field.
  const pf = profData ? portrayalEffectiveValue(profData) : null;
  return {
    id: row.id,
    profile_id: row.profileId,
    profile_name: name,
    status: row.status,
    reason: row.reason,
    phrase: switchPhrase(name, row.id),
    user_relationship: userRelationship,
    portrayal_focus: pf,
    portrayal_focus_note: pf ? portrayalActingNote(pf) : null,
    flavor: profData ? mergedFlavorView(profData) : { level: 3, traits: [] },
    video_notes: profData ? (profData.background.video_notes ?? null) : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const generationRequestOut = z.object({
  id: z.string(),
  profile_id: z.string().nullable(),
  profile_name: z.string().nullable(),
  kind: z.enum([
    "image_generation",
    "link_summary",
    "trial_conversation",
    "profile_apply",
    "flavor_examples",
    "video_transcript",
  ]),
  payload: z.string(),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  result: z.string().nullable(),
  reason: z.string().nullable(),
  // CR-04: canned phrase for profile_apply requests (same format as the
  // switch phrase) so the user can paste it into chat as the trigger.
  // Null for other kinds.
  phrase: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

type GenRow = typeof schema.generationRequests.$inferSelect;

async function toGenOut(
  ctx: Ctx,
  row: GenRow,
): Promise<z.infer<typeof generationRequestOut>> {
  const db = ctx.db<typeof schema>();
  let name: string | null = null;
  if (row.profileId) {
    const profs = await db
      .select({ name: schema.profiles.name })
      .from(schema.profiles)
      .where(eq(schema.profiles.id, row.profileId))
      .limit(1);
    name = profs[0]?.name ?? null;
  }
  return {
    id: row.id,
    profile_id: row.profileId,
    profile_name: name,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    result: row.result,
    reason: row.reason,
    phrase:
      row.kind === "profile_apply" && name ? applyPhrase(name, row.id) : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function insertProfile(
  ctx: Ctx,
  name: string,
  data: ProfileData,
  opts: { favorite?: boolean; isDefault?: boolean } = {},
): Promise<string> {
  const db = ctx.db<typeof schema>();
  const id = newId("av");
  const now = new Date();
  const clean: ProfileData = withPreparation(
    recoverImages({
      ...data,
      switch_settings: {
        pass_conversation_summary: false,
        use_shared_info: data.switch_settings.use_shared_info,
      },
    }),
  );
  await db.insert(schema.profiles).values({
    id,
    name,
    data: JSON.stringify(clean),
    favorite: opts.favorite ?? false,
    isActive: false,
    isDefault: opts.isDefault ?? false,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    deletedAt: null,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const Actions = {
  listProfiles: defineAction({
    description:
      "Lists avatar profiles (not deleted) in the requested sort order, plus the active profile id and the latest switch requests.",
    request: z.object({
      sort: z.enum(["last_used", "name", "created"]).default("last_used"),
    }),
    response: z.object({
      profiles: z.array(profileOutSchema),
      active_id: z.string().nullable(),
      switch_requests: z.array(switchRequestOut),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(isNull(schema.profiles.deletedAt));
      const sorted = [...rows].sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        if (args.sort === "name") return a.name.localeCompare(b.name, "ja");
        if (args.sort === "created")
          return b.createdAt.getTime() - a.createdAt.getTime();
        const au = a.lastUsedAt?.getTime() ?? a.updatedAt.getTime();
        const bu = b.lastUsedAt?.getTime() ?? b.updatedAt.getTime();
        return bu - au;
      });
      const profiles = await Promise.all(
        sorted.map((r) => toProfileOut(ctx, r)),
      );
      const active = rows.find((r) => r.isActive);
      const reqRows = await db
        .select()
        .from(schema.switchRequests)
        .orderBy(desc(schema.switchRequests.createdAt))
        .limit(5);
      const switch_requests = await Promise.all(
        reqRows.map((r) => toSwitchOut(ctx, r)),
      );
      return { profiles, active_id: active?.id ?? null, switch_requests };
    },
  }),

  getProfile: defineAction({
    description: "Returns one avatar profile by id (including trashed ones).",
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ profile: profileOutSchema }),
    async handler(ctx, args) {
      const row = await getRow(ctx, args.id);
      return { profile: await toProfileOut(ctx, row) };
    },
  }),

  createProfile: defineAction({
    description:
      "Creates a new avatar profile from the create/edit form input and returns its id. CR-10: data.theme_color / theme_color_source carry the theme color — auto (acquired from the representative image's dominant color or inferred from the appearance elements), manual (user-picked, never auto-overwritten), or default (fallback color). CR-12: if any flavor trait has auto_examples on and no examples yet, a flavor_examples generation request is queued for the new profile (see updateProfile). CR-17: if the profile carries 参考動画URL (background.video_urls) that no transcript attempt has covered yet, exactly one video_transcript generation request is queued for it (payload: the video URLs plus name / background summary / current speech as context) and its id is returned as video_transcript_request_id.",
    request: profileInputSchema,
    response: z.object({
      id: z.string(),
      video_transcript_request_id: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const id = await insertProfile(ctx, args.name, args.data, { favorite: args.favorite });
      // CR-12: traits saved with 「例文を自動作成」 on and no examples
      // get a flavor_examples request right away.
      const row = await getRow(ctx, id);
      const data = parseData(row.data);
      await queueFlavorExamplesRequest(ctx, id, row.name, data);
      // CR-17: unprocessed reference videos queue one transcript request.
      const videoRequestId = await queueVideoTranscriptRequest(
        ctx,
        id,
        row.name,
        data,
      );
      ctx.invalidateQueries();
      return { id, video_transcript_request_id: videoRequestId };
    },
  }),

  registerProfile: defineAction({
    description:
      "Registers a profile made outside this app (auto-save path for the chat agent). If a non-deleted profile with the same name already exists, returns duplicate:true with the existing id instead of creating a copy.",
    request: profileInputSchema,
    response: z.object({ id: z.string(), duplicate: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .where(
          and(
            eq(schema.profiles.name, args.name),
            isNull(schema.profiles.deletedAt),
          ),
        )
        .limit(1);
      if (existing[0]) return { id: existing[0].id, duplicate: true };
      const data: ProfileData = {
        ...args.data,
        origin: { ...args.data.origin, type: "auto_saved" },
      };
      const id = await insertProfile(ctx, args.name, data);
      // CR-12: same flavor_examples queueing as createProfile.
      const row = await getRow(ctx, id);
      const parsed = parseData(row.data);
      await queueFlavorExamplesRequest(ctx, id, row.name, parsed);
      // CR-17: same video_transcript queueing as createProfile.
      await queueVideoTranscriptRequest(ctx, id, row.name, parsed);
      ctx.invalidateQueries();
      return { id, duplicate: false };
    },
  }),

  updateProfile: defineAction({
    description:
      "Partially updates a profile's editable fields, first saving the previous version into its history (latest 20 kept). Fields the payload leaves empty keep their stored values (D-02): images, greeting, link_summary, avatar_memory, candidate_id, summary, background text/links, call_user_as, speech style, voice kind/speed, and the whole image_base (type, image_ref, and all 13 elements — a default-stub image_base never overwrites a stored one). List a field in allow_clear to clear it intentionally (\"image_base\" / \"elements\" / \"elements:<key>\" / \"image_ref\" address the image base). If background.links were added or changed and are non-empty, a link_summary regeneration request is queued automatically and preparation returns to pending; link_summary_requeued in the response reports whether that happened. CR-03: with apply_now=true the save also queues exactly one immediate-apply request — a profile_apply generation request (payload: image_ref, primary image, name, speech style, call_user_as) when the profile is active, or a normal switch request when it is not; apply_kind/apply_request_id in the response report which. apply_now=false (default) is save-only. CR-04: apply_phrase carries the canned phrase for that request (paste it into chat to trigger it). CR-06: speech carries structured fields (structured.first_person/second_person/catchphrase/memo plus top-level call_user_as and speech.style) with per-field sources (speech.sources: auto/manual/null); values changed through this action become manual and are protected from generation write-backs, empty speech fields keep stored values unless listed in allow_clear (speech_first_person / speech_second_person / speech_catchphrase / speech_memo), and the profile_apply payload includes the merged speech fields (speech / speech_structured / speech_sources). CR-07: background.user_relationship is the optional 「私の扱い」 (what the user is to this character — master, friend, …); it is preserved on empty like the other background fields (allow_clear: \"user_relationship\" clears it intentionally), is carried in the auto link_summary requeue payload and in the profile_apply payload (user_relationship / background_user_relationship), and switch requests expose it on their output for the chat side. CR-08: data.flavor is the フレーバー設定 {level 0-5 (default 3), traits[{id, label, examples[], scenes[], enabled, source auto/manual}]}; traits added/changed through this action become manual (protected from generation write-backs), an empty traits payload keeps the stored flavor unless allow_clear lists \"flavor_traits\", and the profile_apply payload includes the merged flavor (flavor / flavor_level / flavor_traits / flavor_enabled_traits: level + enabled traits only). CR-10: data carries theme_color (#rrggbb) + theme_color_source (auto/manual/default); a manual theme color is never overwritten by automatic acquisition or stub payloads (list \"theme_color\" in allow_clear when the user changed it or returned it to automatic on purpose), and a still-default profile is initialized from its appearance elements on read. CR-14: each flavor trait also carries frequency (0-5 or null; null = follow the global level, a number overrides it for that trait only, same stage meanings as the global bar). Switch output, profile_apply payloads, and generation payloads carry per-trait effective_frequency (frequency ?? level) and frequency_is_custom; a trait with effective_frequency 0 is handed over with 0 explicitly and must be treated like a disabled trait (never shown). Legacy traits parse with frequency null, so existing profiles behave exactly as before. CR-12: each flavor trait carries auto_examples (「例文を自動作成」); when a save leaves any trait with auto_examples on and no examples, a flavor_examples generation request is queued for the profile (an already-open one is refreshed with the current targets instead of duplicated) and its id is returned as flavor_examples_request_id. The request payload carries the target traits (id/label/scenes) plus speech, summary, background summary, and user_relationship as context. CR-17: background carries video_urls (参考動画URL, kept separate from links), video_notes (tone findings from the videos' dialogue), unreadable_videos, and video_processed_urls; video_urls are preserved on empty like links (allow_clear: \"video_urls\" clears them intentionally) and the generation-managed video fields survive stub payloads. When a save leaves any video URL no transcript attempt has covered, exactly one video_transcript generation request is queued or refreshed for the profile and its id is returned as video_transcript_request_id; the profile_apply payload and the auto link_summary requeue carry video_notes as tone reference material. CR-19: background.portrayal_focus is the optional 「演じる姿・状況」 (a specific portrayal/situation to bias toward — 中学生の時のみ / 闇落ちした状態 / もしものif設定 etc.); it is preserved on empty like user_relationship (allow_clear: \"portrayal_focus\" clears it intentionally). Only when set: generation payloads carry portrayal_focus + portrayal_focus_note (use ONLY the material matching that portrayal/situation; for videos pick the matching chapters/segments; if nothing matches, report that in the write-back instead of filling from other states), and the profile_apply payload carries it with the acting premise (respond in that portrayal/situation). When empty, no portrayal keys or bias instructions appear anywhere and behavior is exactly as before. CR-20: when portrayal_focus actually changes in a save (set, changed, or cleared), re-inference is queued under the new bias — a link_summary request is re-queued when the profile has background links, and a video_transcript request is re-queued with force (already-processed videos included) when it has reference videos; a save that leaves the value unchanged queues neither for this reason.",
    request: z.object({
      id: z.string().min(1),
      name: z.string().trim().min(1).max(100),
      data: profileDataSchema,
      favorite: z.boolean().optional(),
      change_label: z.string().max(200).default("編集"),
      // Field names the caller intentionally cleared (e.g. the UI's
      // 固有の記憶リセット, or a textarea the user emptied on purpose).
      // Listed fields are exempt from the preserve-on-empty merge (D-02).
      allow_clear: z.array(z.string().max(50)).max(40).default([]),
      // CR-03: false = 保存のみ (applies at the next switch). true =
      // 保存して今すぐ反映: for the ACTIVE profile exactly one
      // profile_apply generation request is queued; for a non-active
      // profile a normal switch request is queued instead.
      apply_now: z.boolean().default(false),
    }),
    response: z.object({
      ok: z.literal(true),
      link_summary_requeued: z.boolean(),
      // CR-12: id of the flavor_examples request this save queued or
      // refreshed (null when no trait needs auto-generated examples).
      flavor_examples_request_id: z.string().nullable(),
      // CR-17: id of the video_transcript request this save queued or
      // refreshed (null when no reference video is unprocessed).
      video_transcript_request_id: z.string().nullable(),
      apply_kind: z
        .enum(["profile_apply", "switch"])
        .nullable(),
      apply_request_id: z.string().nullable(),
      // CR-04: the canned phrase for the queued request (apply or switch),
      // so the UI can show it with a copy button right after saving. The
      // user pastes it into chat as the formal trigger.
      apply_phrase: z.string().nullable(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{
      ok: true;
      link_summary_requeued: boolean;
      flavor_examples_request_id: string | null;
      video_transcript_request_id: string | null;
      apply_kind: "profile_apply" | "switch" | null;
      apply_request_id: string | null;
      apply_phrase: string | null;
    }> {
      const db = ctx.db<typeof schema>();
      const row = await getRow(ctx, args.id);
      const before = parseData(row.data);
      await pushHistory(ctx, row, args.change_label);
      // Partial update (D-02/R-01): anything the payload did not carry
      // (images and image_base above all) keeps its stored value. The
      // merge runs BEFORE the link-change check so a payload that left
      // the links empty (and therefore kept the stored ones) is not
      // mistaken for a link change.
      const merged = mergePreservingManagedFields(before, args.data, args.allow_clear);
      // CR-17: drop transcript bookkeeping entries for video URLs that
      // are no longer on the profile — a removed video's failure record
      // or processed mark must not linger and mislead the detail screen.
      {
        const currentVideoUrls = normalizeVideoUrls(merged.background.video_urls);
        const entryIsCurrent = (e: string) =>
          currentVideoUrls.some((u) => e === u || e.startsWith(u));
        merged.background = {
          ...merged.background,
          unreadable_videos:
            merged.background.unreadable_videos.filter(entryIsCurrent),
          video_processed_urls:
            merged.background.video_processed_urls.filter(entryIsCurrent),
        };
      }
      const normalizeLinks = (links: string[]) =>
        links.map((l) => l.trim()).filter(Boolean);
      const oldLinks = normalizeLinks(before.background.links);
      const newLinks = normalizeLinks(merged.background.links);
      const linksChanged =
        oldLinks.length !== newLinks.length ||
        oldLinks.some((l, i) => l !== newLinks[i]);
      // CR-20: a portrayal_focus value that ACTUALLY changed (set,
      // changed, or cleared — compared after the preserve-on-empty
      // merge, so an untouched save does not count) re-runs inference
      // under the new bias: link_summary is re-queued when the profile
      // has background links, and video_transcript is re-queued with
      // force below when it has reference videos (already-processed
      // videos are re-processed so their material is re-selected under
      // the new specification). An unchanged value queues nothing.
      const portrayalChanged =
        (before.background.portrayal_focus?.trim() || null) !==
        (merged.background.portrayal_focus?.trim() || null);
      // CR-21 addendum 2: the set → cleared transition specifically is
      // a REPAIR trigger. The re-queues fired by this save (link_summary
      // below, video_transcript further down) additionally carry the
      // current avatar_memory with the instruction to strip any
      // elements that were written into it because of the removed
      // specification, so the unbiased write-backs repair the memory
      // along with the summary / notes. Any other save — focus set,
      // edited, or untouched — carries no repair fields at all.
      const portrayalCleared =
        portrayalChanged &&
        !!(before.background.portrayal_focus?.trim()) &&
        !(merged.background.portrayal_focus?.trim());
      // CR-21: a changed (set / edited / cleared) portrayal_focus
      // invalidates the previous check verdict — the state resets to
      // 未判定 (unknown) with no recorded checks and no failure reason,
      // and the CR-20 re-queue below re-judges it against the new
      // specification. An unchanged save keeps the stored verdict.
      if (portrayalChanged) {
        merged.background = {
          ...merged.background,
          portrayal_focus_status: "unknown",
          portrayal_focus_failure_reason: null,
          portrayal_focus_checks: {
            link_summary: null,
            video_transcript: null,
          },
        };
      }
      const requeue =
        (linksChanged || portrayalChanged) && newLinks.length > 0;
      const dataIn: ProfileData = requeue
        ? {
            ...merged,
            preparation: { ...merged.preparation, link_summary: "pending" },
            preparation_errors: { ...merged.preparation_errors, link_summary: null },
          }
        : merged;
      const clean: ProfileData = withPreparation({
        ...dataIn,
        switch_settings: {
          pass_conversation_summary: false,
          use_shared_info: args.data.switch_settings.use_shared_info,
        },
      });
      const now = new Date();
      await db
        .update(schema.profiles)
        .set({
          name: args.name,
          data: JSON.stringify(clean),
          ...(args.favorite !== undefined ? { favorite: args.favorite } : {}),
          updatedAt: now,
        })
        .where(eq(schema.profiles.id, args.id));
      if (requeue) {
        await db.insert(schema.generationRequests).values({
          id: newId("gen"),
          profileId: args.id,
          kind: "link_summary",
          payload: JSON.stringify({
            links: newLinks,
            // CR-07: 「私の扱い」 travels with generation requests so
            // summaries/greetings reflect the specified relationship.
            user_relationship: clean.background.user_relationship ?? null,
            // CR-17: tone findings from the reference videos' dialogue,
            // as reference material for summary/greeting generation.
            video_notes: clean.background.video_notes ?? null,
            background_video_notes: clean.background.video_notes ?? null,
            video_notes_note:
              "video_notes は参考動画の文字起こし（台詞）から読み取れた口調の特徴です。ある場合は、要約や口調の推定でその口癖・語尾・言い回しを参考資料の1つとして使ってください（推定の時点で動画の知見を統合してください）。null の場合は動画由来の材料はまだありません。",
            // CR-19: only when 「演じる姿・状況」 is set — the summary
            // is built from the matching parts of the links only.
            ...portrayalGenerationFields(clean),
            // CR-21 addendum 2: only when this re-queue is the repair
            // re-queue of a portrayal_focus removal — the current
            // avatar_memory plus the strip-the-specification repair
            // instruction (empty object otherwise).
            ...(portrayalCleared
              ? portrayalMemoryRepairFields(clean)
              : {}),
            speech: mergedSpeechView(clean),
            speech_structured: {
              first_person: clean.speech.structured.first_person,
              second_person: clean.speech.structured.second_person,
              call_user_as: clean.call_user_as,
              catchphrase: clean.speech.structured.catchphrase,
              memo: clean.speech.structured.memo,
            },
            speech_sources: { ...clean.speech.sources },
            manual_speech_fields: manualSpeechFields(clean),
            // CR-20: the speech write-back follows the same merge rules
            // as video_transcript (CR-18) — stated explicitly here.
            speech_note: SPEECH_MERGE_NOTE,
            speech_merge_note: SPEECH_MERGE_NOTE,
            note: SPEECH_MERGE_NOTE,
            // CR-08: flavor travels with generation requests so the
            // chat side can infer flavor traits from the links and
            // write them back as "auto" (manual traits are protected).
            // CR-14: each trait carries frequency (null = follow global)
            // and effective_frequency (frequency ?? level).
            flavor: mergedFlavorView(clean),
            flavor_level: clean.flavor.level,
            flavor_traits: (clean.flavor?.traits ?? []).map((t) => ({
              ...t,
              effective_frequency: effectiveFlavorFrequency(t, clean.flavor.level),
            })),
            manual_flavor_traits: manualFlavorTraits(clean).map((t) => ({
              label: t.label,
              examples: [...t.examples],
              scenes: [...t.scenes],
              frequency: t.frequency ?? null,
              effective_frequency: effectiveFlavorFrequency(t, clean.flavor.level),
            })),
            flavor_note:
              "フレーバー項目を背景リンクから推定できる場合は、書き戻し result の flavor_traits（または flavor.traits）に含めてください。各項目は {label, examples[], scenes[], enabled} の形です。" +
              FLAVOR_MERGE_NOTE +
              " CR-14: 各項目には frequency（項目ごとの頻度、null=全体に従う）と effective_frequency（実効頻度 = frequency ?? level）が付きます。実効頻度0の項目は出さないでください。",
          }),
          status: "pending",
          result: null,
          reason: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      // CR-12: flavor traits with auto_examples on and no examples yet
      // queue a flavor_examples request (or refresh the open one's
      // targets). Trashed profiles get none. Runs on every save,
      // independent of apply_now.
      const flavorExamplesRequestId = row.deletedAt
        ? null
        : await queueFlavorExamplesRequest(ctx, args.id, args.name, clean);
      // CR-17: reference videos no transcript attempt has covered yet
      // queue (or refresh) the profile's single video_transcript
      // request. Trashed profiles get none. Runs on every save,
      // independent of apply_now.
      // CR-20: when portrayal_focus actually changed, the request is
      // queued with force — already-processed videos are re-processed
      // so their material is re-selected under the new specification.
      const videoTranscriptRequestId = row.deletedAt
        ? null
        : await queueVideoTranscriptRequest(ctx, args.id, args.name, clean, {
            force: portrayalChanged,
            // CR-21 addendum 2: a portrayal_focus removal makes this
            // re-queue a repair re-queue — its payload also carries
            // the avatar_memory repair fields.
            memoryRepair: portrayalCleared,
          });
      // CR-03 今すぐ反映: exactly one follow-up request, shaped by whether
      // this profile is the active one. Trashed profiles get none (a
      // switch to a trashed profile is not allowed anyway).
      let apply_kind: "profile_apply" | "switch" | null = null;
      let apply_request_id: string | null = null;
      if (args.apply_now && !row.deletedAt) {
        if (row.isActive) {
          const primary =
            clean.images.find((i) => i.is_primary) ?? clean.images[0] ?? null;
          apply_request_id = newId("gen");
          await db.insert(schema.generationRequests).values({
            id: apply_request_id,
            profileId: args.id,
            kind: "profile_apply",
            payload: JSON.stringify({
              name: args.name,
              image_base: {
                type: clean.image_base.type,
                image_ref: clean.image_base.image_ref,
              },
              image_ref: clean.image_base.image_ref,
              primary_image: primary
                ? {
                    id: primary.id,
                    file: primary.file,
                    blob_key: primary.blob_key,
                    source: primary.source,
                  }
                : null,
              primary_image_file:
                primary?.file ?? clean.image_base.image_ref,
              speech_style: clean.speech.style,
              speech_tuning: clean.speech.tuning,
              call_user_as: clean.call_user_as,
              // CR-06: the merged (manual-priority) structured speech
              // fields. Stored values already are the merge result, and
              // the chat side treats this as authoritative for tone.
              speech: mergedSpeechView(clean),
              speech_structured: {
                first_person: clean.speech.structured.first_person,
                second_person: clean.speech.structured.second_person,
                call_user_as: clean.call_user_as,
                catchphrase: clean.speech.structured.catchphrase,
                memo: clean.speech.structured.memo,
                style: clean.speech.style,
              },
              speech_sources: { ...clean.speech.sources },
              // CR-07: 「私の扱い」 is authoritative for how the avatar
              // treats the user after applying (master/servant, equal
              // friends, … — distance and attitude, not just the name).
              user_relationship: clean.background.user_relationship ?? null,
              background_user_relationship:
                clean.background.user_relationship ?? null,
              // CR-17: tone findings from the reference videos'
              // dialogue — reference material for the applied tone.
              video_notes: clean.background.video_notes ?? null,
              background_video_notes: clean.background.video_notes ?? null,
              // CR-08: the merged flavor setting (manual-priority):
              // the user's level plus the ENABLED traits only. The chat
              // side performs flavor in its replies according to this —
              // level 0 = none, 1-2 = only at key moments, 3 = naturally
              // at milestones, 4-5 = frequently.
              // CR-14: each trait carries effective_frequency; the chat
              // side follows THAT per trait (0 = never show that trait,
              // even when the global level is high).
              flavor: mergedFlavorView(clean),
              flavor_level: clean.flavor.level,
              flavor_traits: mergedFlavorView(clean).traits,
              flavor_enabled_traits: mergedFlavorView(clean).traits,
              // CR-19: only when 「演じる姿・状況」 is set — it is the
              // premise for how to act after applying (empty object when
              // unused, so the payload is unchanged then).
              ...portrayalActingFields(clean),
              summary: clean.summary,
              note:
                "アクティブなプロファイルの更新を即時反映してください。口調・名前・呼び方は即時適用し、画像が変わっていれば候補生成→ユーザー選択→セットまで行ってください。user_relationship（私の扱い）が指定されている場合は、切り替え後のユーザーへの接し方（距離感・態度）の基準としてそれを正としてください。未指定（null）の場合は背景や呼び方から自然に推定される扱いのままで構いません。video_notes（参考動画の台詞から読み取れた口調の特徴）がある場合は、口調の参考資料として併せて使ってください。flavor（フレーバー設定）がある場合は、各項目の実効頻度（effective_frequency = 項目の frequency ?? 全体の level）に従って応答にキャラクターらしいフレーバーを出してください（実効0=その項目は出さない、1〜2=ここぞの場面だけ、3=節目に自然に、4〜5=頻繁に）。全体の level だけで判断せず、項目ごとの effective_frequency を優先してください。書き戻しは candidate_id と image_ref のみです。" +
                (portrayalEffectiveValue(clean)
                  ? ` ${portrayalActingNote(portrayalEffectiveValue(clean) as string)}`
                  : ""),
            }),
            status: "pending",
            result: null,
            reason: null,
            createdAt: now,
            updatedAt: now,
          });
          apply_kind = "profile_apply";
        } else {
          apply_request_id = newId("sw");
          await db.insert(schema.switchRequests).values({
            id: apply_request_id,
            profileId: args.id,
            status: "pending",
            reason: null,
            createdAt: now,
            updatedAt: now,
          });
          apply_kind = "switch";
        }
      }
      ctx.invalidateQueries();
      return {
        ok: true,
        link_summary_requeued: requeue,
        flavor_examples_request_id: flavorExamplesRequestId,
        video_transcript_request_id: videoTranscriptRequestId,
        apply_kind,
        apply_request_id,
        apply_phrase:
          apply_kind === "profile_apply" && apply_request_id
            ? applyPhrase(args.name, apply_request_id)
            : apply_kind === "switch" && apply_request_id
              ? switchPhrase(args.name, apply_request_id)
              : null,
      };
    },
  }),

  duplicateProfile: defineAction({
    description: "Duplicates a profile under a new id (name gets a コピー suffix).",
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ id: z.string() }),
    async handler(ctx, args) {
      const row = await getRow(ctx, args.id);
      const data = parseData(row.data);
      data.images = data.images.map((img) => ({ ...img }));
      const id = await insertProfile(ctx, `${row.name} のコピー`, data);
      ctx.invalidateQueries();
      return { id };
    },
  }),

  toggleFavorite: defineAction({
    description: "Pins or unpins a profile (favorite).",
    request: z.object({ id: z.string().min(1), favorite: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await getRow(ctx, args.id);
      await db
        .update(schema.profiles)
        .set({ favorite: args.favorite, updatedAt: new Date() })
        .where(eq(schema.profiles.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteProfile: defineAction({
    description:
      "Moves a profile to the trash (soft delete, restorable for 30 days). The default profile cannot be deleted.",
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const row = await getRow(ctx, args.id);
      if (row.isDefault)
        throw new Error("既定アバターのプロファイルは削除できません。");
      await db
        .update(schema.profiles)
        .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
        .where(eq(schema.profiles.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listTrash: defineAction({
    description: "Lists profiles in the trash with their deletion dates.",
    request: z.object({}),
    response: z.object({ profiles: z.array(profileOutSchema) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .orderBy(desc(schema.profiles.deletedAt));
      const deleted = rows.filter((r) => r.deletedAt != null);
      const profiles = await Promise.all(
        deleted.map((r) => toProfileOut(ctx, r)),
      );
      return { profiles };
    },
  }),

  restoreProfile: defineAction({
    description: "Restores a trashed profile back to the list.",
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await getRow(ctx, args.id);
      await db
        .update(schema.profiles)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(schema.profiles.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  purgeProfile: defineAction({
    description: "Permanently deletes a trashed profile and its history.",
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const row = await getRow(ctx, args.id);
      if (!row.deletedAt)
        throw new Error("ゴミ箱に入っていないプロファイルは完全削除できません。");
      await db
        .delete(schema.profileHistory)
        .where(eq(schema.profileHistory.profileId, args.id));
      await db
        .delete(schema.profiles)
        .where(eq(schema.profiles.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // -- Images ---------------------------------------------------------------

  uploadImage: defineAction({
    description:
      "Stores an uploaded image (PNG/JPG/WebP, up to about 10MB) as a blob and adds it to the profile's image list. CR-10: theme_color_candidate (the image's dominant color as a #rrggbb hex, extracted client-side) becomes the profile's theme color with source auto — unless the user set the theme color manually, in which case the manual color is kept.",
    request: z.object({
      profile_id: z.string().min(1),
      data_base64: z.string().min(1).max(14_000_000),
      mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
      make_primary: z.boolean().default(true),
      theme_color_candidate: z.string().max(20).nullable().default(null),
    }),
    response: z.object({ image_id: z.string(), url: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const row = await getRow(ctx, args.profile_id);
      const bytes = Buffer.from(args.data_base64, "base64");
      if (bytes.length > 10 * 1024 * 1024)
        throw new Error("画像は10MBまでです（アプリ側ルール）。");
      const key = `avatars/${args.profile_id}/${newId("img")}`;
      await ctx.blobs.put(key, bytes, { contentType: args.mime_type });
      const data = parseData(row.data);
      const imageId = newId("im");
      const makePrimary = args.make_primary || data.images.length === 0;
      data.images = [
        ...data.images.map((img) => ({
          ...img,
          is_primary: makePrimary ? false : img.is_primary,
        })),
        {
          id: imageId,
          file: key,
          blob_key: key,
          is_primary: makePrimary,
          source: "upload",
        },
      ];
      data.image_base = { ...data.image_base, type: "image", image_ref: key };
      // CR-10: a new representative image re-acquires the theme color
      // from the image — except when the user picked it manually.
      if (
        isValidThemeColor(args.theme_color_candidate) &&
        data.theme_color_source !== "manual"
      ) {
        data.theme_color = (args.theme_color_candidate as string).toLowerCase();
        data.theme_color_source = "auto";
      }
      // Registering a replacement image is one of the A-09 alternatives:
      // it clears a previous image-generation failure (D-03).
      data.preparation = { ...data.preparation, image: "done" };
      data.preparation_errors = { ...data.preparation_errors, image: null };
      const withPrep = withPreparation(data);
      await db
        .update(schema.profiles)
        .set({ data: JSON.stringify(withPrep), updatedAt: new Date() })
        .where(eq(schema.profiles.id, args.profile_id));
      ctx.invalidateQueries();
      return { image_id: imageId, url: await ctx.blobs.getUrl(key) };
    },
  }),

  addImageByUrl: defineAction({
    description:
      "Registers an image URL as one of the profile's images. CR-10: theme_color_candidate (#rrggbb, extracted client-side when the image is readable) becomes the theme color with source auto, unless the theme color was set manually.",
    request: z.object({
      profile_id: z.string().min(1),
      url: z.string().url().max(2000),
      make_primary: z.boolean().default(true),
      theme_color_candidate: z.string().max(20).nullable().default(null),
    }),
    response: z.object({ image_id: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const row = await getRow(ctx, args.profile_id);
      const data = parseData(row.data);
      const imageId = newId("im");
      const makePrimary = args.make_primary || data.images.length === 0;
      data.images = [
        ...data.images.map((img) => ({
          ...img,
          is_primary: makePrimary ? false : img.is_primary,
        })),
        {
          id: imageId,
          file: args.url,
          blob_key: null,
          is_primary: makePrimary,
          source: "url",
        },
      ];
      data.image_base = {
        ...data.image_base,
        type: "image",
        image_ref: args.url,
      };
      // CR-10: same manual-priority theme re-acquisition as uploadImage.
      if (
        isValidThemeColor(args.theme_color_candidate) &&
        data.theme_color_source !== "manual"
      ) {
        data.theme_color = (args.theme_color_candidate as string).toLowerCase();
        data.theme_color_source = "auto";
      }
      data.preparation = { ...data.preparation, image: "done" };
      data.preparation_errors = { ...data.preparation_errors, image: null };
      const withPrep2 = withPreparation(data);
      await db
        .update(schema.profiles)
        .set({ data: JSON.stringify(withPrep2), updatedAt: new Date() })
        .where(eq(schema.profiles.id, args.profile_id));
      ctx.invalidateQueries();
      return { image_id: imageId };
    },
  }),

  setPrimaryImage: defineAction({
    description:
      "Makes one of the profile's images the primary image. CR-10: theme_color_candidate (#rrggbb for the new primary image) re-acquires the theme color as auto, unless it was set manually.",
    request: z.object({
      profile_id: z.string().min(1),
      image_id: z.string().min(1),
      theme_color_candidate: z.string().max(20).nullable().default(null),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const row = await getRow(ctx, args.profile_id);
      const data = parseData(row.data);
      if (!data.images.some((i) => i.id === args.image_id))
        throw new Error("画像が見つかりません。");
      data.images = data.images.map((img) => ({
        ...img,
        is_primary: img.id === args.image_id,
      }));
      if (
        isValidThemeColor(args.theme_color_candidate) &&
        data.theme_color_source !== "manual"
      ) {
        data.theme_color = (args.theme_color_candidate as string).toLowerCase();
        data.theme_color_source = "auto";
      }
      await db
        .update(schema.profiles)
        .set({ data: JSON.stringify(data), updatedAt: new Date() })
        .where(eq(schema.profiles.id, args.profile_id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  removeImage: defineAction({
    description: "Removes one image from a profile (older images stay until removed).",
    request: z.object({
      profile_id: z.string().min(1),
      image_id: z.string().min(1),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const row = await getRow(ctx, args.profile_id);
      const data = parseData(row.data);
      const target = data.images.find((i) => i.id === args.image_id);
      data.images = data.images.filter((i) => i.id !== args.image_id);
      if (target?.is_primary && data.images[0]) data.images[0].is_primary = true;
      if (target?.blob_key) {
        try {
          await ctx.blobs.delete(target.blob_key);
        } catch {
          // Blob cleanup is best-effort; the profile row is the source of truth.
        }
      }
      await db
        .update(schema.profiles)
        .set({ data: JSON.stringify(withPreparation(data)), updatedAt: new Date() })
        .where(eq(schema.profiles.id, args.profile_id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // -- History ---------------------------------------------------------------

  listHistory: defineAction({
    description: "Lists a profile's saved versions (newest first, up to 20).",
    request: z.object({ profile_id: z.string().min(1) }),
    response: z.object({
      versions: z.array(
        z.object({
          id: z.number(),
          label: z.string(),
          name: z.string(),
          created_at: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await getRow(ctx, args.profile_id);
      const rows = await db
        .select()
        .from(schema.profileHistory)
        .where(eq(schema.profileHistory.profileId, args.profile_id))
        .orderBy(desc(schema.profileHistory.id))
        .limit(20);
      return {
        versions: rows.map((r) => {
          let name = "";
          try {
            name = String(
              (JSON.parse(r.snapshot) as { name?: string }).name ?? "",
            );
          } catch {
            name = "";
          }
          return {
            id: r.id,
            label: r.label,
            name,
            created_at: r.createdAt.toISOString(),
          };
        }),
      };
    },
  }),

  restoreHistory: defineAction({
    description:
      "Restores a profile to a saved version; the current state is itself saved to history first.",
    request: z.object({
      profile_id: z.string().min(1),
      history_id: z.number().int().positive(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const row = await getRow(ctx, args.profile_id);
      const versions = await db
        .select()
        .from(schema.profileHistory)
        .where(eq(schema.profileHistory.id, args.history_id))
        .limit(1);
      const version = versions[0];
      if (!version || version.profileId !== args.profile_id)
        throw new Error("指定された版が見つかりません。");
      const snap = JSON.parse(version.snapshot) as {
        name: string;
        favorite: boolean;
        data: unknown;
      };
      // Partial-update rule (D-02/R-01): a snapshot recorded while D-02
      // was active may carry an empty images list; restoring it must not
      // wipe the images the profile has now. Non-empty snapshot values
      // still win, so a genuine restore behaves as before.
      const restored = withPreparation(
        mergePreservingManagedFields(
          parseData(row.data),
          profileDataSchema.parse(snap.data),
        ),
      );
      await pushHistory(ctx, row, "復元前の状態");
      await db
        .update(schema.profiles)
        .set({
          name: snap.name,
          favorite: Boolean(snap.favorite),
          data: JSON.stringify(restored),
          updatedAt: new Date(),
        })
        .where(eq(schema.profiles.id, args.profile_id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // -- Switch requests --------------------------------------------------------

  requestSwitch: defineAction({
    description:
      "Creates a pending switch request for a profile (one tap, no confirmation). Returns the request id and the canned phrase to send in chat so the agent applies the switch. The request output also carries the profile's 「私の扱い」 (background.user_relationship, CR-07) as the basis for how to treat the user after the switch, its merged flavor setting (CR-08: level + enabled traits), and video_notes (CR-17: tone findings from the reference videos' dialogue) in listPendingSwitchRequests output. CR-19: the output also carries portrayal_focus + portrayal_focus_note (「演じる姿・状況」) — both null when the profile does not use the field (no bias, act as before); when set, act in that portrayal/situation after the switch.",
    request: z.object({ profile_id: z.string().min(1) }),
    response: z.object({
      request_id: z.string(),
      phrase: z.string(),
      profile_name: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const row = await getRow(ctx, args.profile_id);
      if (row.deletedAt) throw new Error("ゴミ箱の中のプロファイルには切り替えられません。");
      const id = newId("sw");
      const now = new Date();
      await db.insert(schema.switchRequests).values({
        id,
        profileId: args.profile_id,
        status: "pending",
        reason: null,
        createdAt: now,
        updatedAt: now,
      });
      ctx.invalidateQueries();
      return {
        request_id: id,
        phrase: switchPhrase(row.name, id),
        profile_name: row.name,
      };
    },
  }),

  listPendingSwitchRequests: defineAction({
    description:
      "Lists switch requests still waiting for the chat-side agent (pending or processing), oldest first.",
    request: z.object({}),
    response: z.object({ requests: z.array(switchRequestOut) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.switchRequests)
        .orderBy(schema.switchRequests.createdAt);
      const open = rows.filter(
        (r) => r.status === "pending" || r.status === "processing",
      );
      const requests = await Promise.all(open.map((r) => toSwitchOut(ctx, r)));
      return { requests };
    },
  }),

  completeSwitchRequest: defineAction({
    description:
      "Writes back the result of a switch request. On completed, the target profile becomes active and its last-used time updates; on failed, the reason is shown and the active avatar stays unchanged.",
    request: z.object({
      request_id: z.string().min(1),
      status: z.enum(["processing", "completed", "failed"]),
      reason: z.string().max(1000).nullable().default(null),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.switchRequests)
        .where(eq(schema.switchRequests.id, args.request_id))
        .limit(1);
      const req = rows[0];
      if (!req) throw new Error("切替リクエストが見つかりません。");
      const now = new Date();
      // A write-back for a profile that has since been trashed must not
      // activate it (R-12): record the switch as failed instead. The switch
      // write-back only ever touches the is_active / last_used columns —
      // never the profile's data payload (partial update, D-02).
      if (args.status === "completed") {
        const target = await db
          .select({ deletedAt: schema.profiles.deletedAt })
          .from(schema.profiles)
          .where(eq(schema.profiles.id, req.profileId))
          .limit(1);
        if (!target[0] || target[0].deletedAt) {
          await db
            .update(schema.switchRequests)
            .set({
              status: "failed",
              reason: "対象プロファイルが削除されているため切り替えられませんでした。",
              updatedAt: now,
            })
            .where(eq(schema.switchRequests.id, args.request_id));
          ctx.invalidateQueries();
          return { ok: true };
        }
      }
      await db
        .update(schema.switchRequests)
        .set({ status: args.status, reason: args.reason, updatedAt: now })
        .where(eq(schema.switchRequests.id, args.request_id));
      if (args.status === "completed") {
        await db
          .update(schema.profiles)
          .set({ isActive: false })
          .where(eq(schema.profiles.isActive, true));
        await db
          .update(schema.profiles)
          .set({ isActive: true, lastUsedAt: now, updatedAt: now })
          .where(eq(schema.profiles.id, req.profileId));
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteSwitchRequest: defineAction({
    description:
      "CR-15: Discards one switch request from the list screen. Only pending, processing, or failed requests can be deleted; a completed request is kept as history and this action rejects it. Deleting an open request removes it from the processing queue, so the target profile's pending-switch count (and its 反映待ち badge) drops accordingly. The profile itself and all other requests are untouched.",
    request: z.object({ request_id: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.switchRequests)
        .where(eq(schema.switchRequests.id, args.request_id))
        .limit(1);
      const req = rows[0];
      if (!req) throw new Error("切替リクエストが見つかりません。");
      if (req.status === "completed")
        throw new Error("完了済みのリクエストは消去できません。");
      await db
        .delete(schema.switchRequests)
        .where(eq(schema.switchRequests.id, args.request_id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getActiveState: defineAction({
    description:
      "Returns the currently active profile (or null) and any open switch requests.",
    request: z.object({}),
    response: z.object({
      active: profileOutSchema.nullable(),
      open_requests: z.array(switchRequestOut),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(
          and(
            eq(schema.profiles.isActive, true),
            isNull(schema.profiles.deletedAt),
          ),
        )
        .limit(1);
      const active = rows[0] ? await toProfileOut(ctx, rows[0]) : null;
      const reqRows = await db
        .select()
        .from(schema.switchRequests)
        .orderBy(desc(schema.switchRequests.createdAt))
        .limit(10);
      const open = reqRows.filter(
        (r) => r.status === "pending" || r.status === "processing",
      );
      const open_requests = await Promise.all(
        open.map((r) => toSwitchOut(ctx, r)),
      );
      return { active, open_requests };
    },
  }),

  // -- Generation requests ----------------------------------------------------

  createGenerationRequest: defineAction({
    description:
      "Queues a request for the chat-side agent: image_generation, link_summary, trial_conversation, profile_apply (CR-03: apply an edit to the active avatar right away; normally created by updateProfile with apply_now=true), or flavor_examples (CR-12: invent example lines for flavor traits whose auto_examples flag is on and whose examples are empty — normally queued automatically by createProfile/updateProfile; when created through this action for a profile, the payload is rebuilt server-side from the profile's current targets and context, and an already-open flavor_examples request for that profile is refreshed instead of duplicated). Payload is a JSON string describing what to generate. For profile_apply the response also carries the canned phrase (CR-04) to paste into chat as the trigger. CR-06: link_summary / trial_conversation payloads are enriched server-side with the profile's merged speech fields (speech / speech_structured), their sources (speech_sources), and manual_speech_fields — infer the non-manual speech fields from the background links/name and return them in the write-back result. CR-07: those payloads also carry user_relationship (「私の扱い」) with a note to follow it in greeting/tone generation when set; it is the user's own specification and must never be changed by a write-back. CR-08: those payloads also carry the flavor setting (flavor: level + enabled traits; flavor_traits: all stored traits; manual_flavor_traits: the protected manual ones) — infer flavor traits from the background links/name and return them in the write-back result as flavor_traits [{label, examples[], scenes[], enabled}]; never change manual traits or the level. video_transcript (CR-17: fetch the transcripts of the profile's 参考動画URL and mine the dialogue for tone — normally queued automatically by createProfile/updateProfile when an unprocessed video URL exists; when created through this action the payload is rebuilt server-side from the profile's current video URLs and context with force, and an already-open video_transcript request is refreshed instead of duplicated). CR-17: link_summary / trial_conversation payloads also carry video_notes (background.video_notes — tone findings from the reference videos' dialogue) as tone reference material. CR-19: when the profile's 「演じる姿・状況」 (background.portrayal_focus) is set, payloads additionally carry portrayal_focus + portrayal_focus_note — for link_summary / flavor_examples / video_transcript / image_generation, use ONLY the source material matching that portrayal/situation (for videos, the matching chapters/segments) and report back (portrayal_focus_no_match) instead of filling from other periods/states when nothing matches; for trial_conversation, respond in that portrayal/situation. When portrayal_focus is empty, no portrayal keys are added at all. CR-20: link_summary payloads state the unified speech/flavor merge rules in their notes (speech_note / speech_merge_note / note, flavor_note) — speech write-backs merge like CR-18 video write-backs (catchphrase union, first/second person fill-only, memo/style as integrated text) and flavor write-backs merge into existing auto traits instead of replacing them; video_transcript payloads carry the current flavor (flavor / flavor_traits with auto/manual distinction, manual_flavor_traits, flavor_note) and their results may carry flavor_traits.",
    request: z.object({
      profile_id: z.string().min(1).nullable().default(null),
      kind: z.enum([
        "image_generation",
        "link_summary",
        "trial_conversation",
        "profile_apply",
        "flavor_examples",
        "video_transcript",
      ]),
      payload: z.string().max(20000).default("{}"),
    }),
    response: z.object({
      request_id: z.string(),
      phrase: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let profileName: string | null = null;
      let payload = args.payload;
      // CR-12: flavor_examples requests are owned by the queue helper —
      // it rebuilds the payload from the profile's current targets and
      // refreshes an already-open request instead of duplicating it.
      if (args.kind === "flavor_examples") {
        if (!args.profile_id)
          throw new Error("flavor_examples には profile_id が必要です。");
        const row = await getRow(ctx, args.profile_id);
        const queuedId = await queueFlavorExamplesRequest(
          ctx,
          args.profile_id,
          row.name,
          parseData(row.data),
        );
        if (!queuedId)
          throw new Error("例文の自動作成が必要なフレーバー項目がありません。");
        ctx.invalidateQueries();
        return { request_id: queuedId, phrase: null };
      }
      // CR-17: video_transcript requests are owned by their queue
      // helper too — the payload is rebuilt server-side from the
      // profile's current video URLs and context, an already-open
      // request is refreshed instead of duplicated, and a manual
      // request (the detail screen's retry) re-queues every current
      // URL even after a failed attempt.
      if (args.kind === "video_transcript") {
        if (!args.profile_id)
          throw new Error("video_transcript には profile_id が必要です。");
        const row = await getRow(ctx, args.profile_id);
        const queuedId = await queueVideoTranscriptRequest(
          ctx,
          args.profile_id,
          row.name,
          parseData(row.data),
          { force: true },
        );
        if (!queuedId)
          throw new Error("参考動画URLが設定されていません。");
        ctx.invalidateQueries();
        return { request_id: queuedId, phrase: null };
      }
      if (args.profile_id) {
        const row = await getRow(ctx, args.profile_id);
        profileName = row.name;
        // CR-06: link_summary / trial_conversation requests carry the
        // profile's merged speech fields, their sources, and the list of
        // manual fields, so the chat side can infer the missing (auto)
        // fields from the background links/name and write them back
        // without touching manual ones.
        if (args.kind === "link_summary" || args.kind === "trial_conversation") {
          const data = parseData(row.data);
          let obj: Record<string, unknown> = {};
          try {
            const p = JSON.parse(args.payload) as unknown;
            if (p && typeof p === "object" && !Array.isArray(p)) {
              obj = p as Record<string, unknown>;
            }
          } catch {
            obj = { note: args.payload };
          }
          obj.speech = mergedSpeechView(data);
          obj.speech_structured = {
            first_person: data.speech.structured.first_person,
            second_person: data.speech.structured.second_person,
            call_user_as: data.call_user_as,
            catchphrase: data.speech.structured.catchphrase,
            memo: data.speech.structured.memo,
          };
          obj.speech_sources = { ...data.speech.sources };
          obj.manual_speech_fields = manualSpeechFields(data);
          // CR-07: 「私の扱い」 — the relationship specification the
          // greeting / summary generation must follow when present.
          obj.user_relationship = data.background.user_relationship ?? null;
          obj.background_user_relationship =
            data.background.user_relationship ?? null;
          obj.user_relationship_note =
            "user_relationship は「私の扱い」（このキャラクターから見てユーザーがどういう存在か）の指定です。指定がある場合は、挨拶文や口調の生成でその関係性（主従・対等などの距離感や態度）に倣ってください。null（未指定）の場合は、背景や呼び方から自然に推定される扱いのままで構いません。この項目自体はユーザーの指定であり、書き戻しで変更しないでください。";
          // CR-17: tone findings from the reference videos' dialogue
          // travel as reference material, above all for trial
          // conversations (greetings must sound like the videos' lines).
          obj.video_notes = data.background.video_notes ?? null;
          obj.background_video_notes = data.background.video_notes ?? null;
          obj.video_notes_note =
            "video_notes は参考動画の文字起こし（台詞）から読み取れた口調の特徴です。ある場合は、挨拶文や口調の生成でその口癖・語尾・言い回しを参考にしてください。null の場合は動画由来の材料はまだありません。";
          obj.speech_note =
            "口調の構造化欄です。manual_speech_fields に挙がった欄はユーザーの手動指定なので書き戻しで変更しないでください。それ以外の欄は背景URLや名前から推定して、書き戻し result の speech（または first_person 等のキー）に含めてください。" +
            SPEECH_MERGE_NOTE;
          // CR-20: the merge rules are also stated under explicit keys
          // (and as the payload note for link_summary) so the chat side
          // cannot miss them.
          obj.speech_merge_note = SPEECH_MERGE_NOTE;
          if (args.kind === "link_summary") obj.note = SPEECH_MERGE_NOTE;
          // CR-08: flavor — the merged view (level + enabled traits),
          // the full stored trait list, and the manual traits the
          // write-back must never change or remove. The chat side
          // infers this character's flavor traits from the background
          // links/name and returns them in the result as flavor_traits
          // (or flavor.traits): [{label, examples[], scenes[],
          // enabled}]. The level is the user's bar setting; never
          // change it in a write-back.
          obj.flavor = mergedFlavorView(data);
          obj.flavor_level = (data.flavor ?? emptyFlavor).level;
          obj.flavor_traits = (data.flavor ?? emptyFlavor).traits.map((t) => ({
            ...t,
            examples: [...t.examples],
            scenes: [...t.scenes],
            frequency: t.frequency ?? null,
            effective_frequency: effectiveFlavorFrequency(
              t,
              (data.flavor ?? emptyFlavor).level,
            ),
          }));
          obj.manual_flavor_traits = manualFlavorTraits(data).map((t) => ({
            label: t.label,
            examples: [...t.examples],
            scenes: [...t.scenes],
            frequency: t.frequency ?? null,
            effective_frequency: effectiveFlavorFrequency(
              t,
              (data.flavor ?? emptyFlavor).level,
            ),
          }));
          obj.flavor_note =
            "フレーバー項目（キャラクターらしさ）です。背景URLや名前から推定できる項目は、書き戻し result の flavor_traits（または flavor.traits）に {label, examples[], scenes[], enabled} の形で含めてください。" +
            FLAVOR_MERGE_NOTE +
            " CR-14: 各項目の frequency（null=全体に従う）から決まる effective_frequency がその項目の実効頻度です。実効0の項目は出さないでください。";
          // CR-19: 「演じる姿・状況」 — ONLY when set. link_summary is
          // material-based generation (use only the matching parts of
          // the sources); trial_conversation is acting (respond in
          // that portrayal/situation). When unset, no portrayal keys
          // are added and the payload is exactly as before.
          // CR-21: while the bias is failed it is inactive — no
          // portrayal keys either (portrayalEffectiveValue is null).
          const pf = portrayalEffectiveValue(data);
          if (pf) {
            obj.portrayal_focus = pf;
            obj.background_portrayal_focus = pf;
            obj.portrayal_focus_note =
              args.kind === "trial_conversation"
                ? portrayalActingNote(pf)
                : portrayalGenerationNote(pf);
          }
          payload = JSON.stringify(obj);
        }
        // CR-19: image_generation — only when 「演じる姿・状況」 is
        // set, the payload gains the value plus the instruction to
        // depict that portrayal/situation. When unset the client's
        // payload passes through untouched.
        if (args.kind === "image_generation") {
          const data = parseData(row.data);
          const pf = portrayalFocusValue(data);
          if (pf) {
            let obj: Record<string, unknown> = {};
            try {
              const p = JSON.parse(args.payload) as unknown;
              if (p && typeof p === "object" && !Array.isArray(p)) {
                obj = p as Record<string, unknown>;
              }
            } catch {
              obj = { note: args.payload };
            }
            obj.portrayal_focus = pf;
            obj.background_portrayal_focus = pf;
            obj.portrayal_focus_note = portrayalImageNote(pf);
            payload = JSON.stringify(obj);
          }
        }
      }
      const id = newId("gen");
      const now = new Date();
      await db.insert(schema.generationRequests).values({
        id,
        profileId: args.profile_id,
        kind: args.kind,
        payload,
        status: "pending",
        result: null,
        reason: null,
        createdAt: now,
        updatedAt: now,
      });
      // Mark preparation as pending for the corresponding item.
      // profile_apply (CR-03) has no preparation item, so it never touches
      // the profile here.
      if (args.profile_id && args.kind !== "profile_apply") {
        const profRows = await db.select().from(schema.profiles).where(eq(schema.profiles.id, args.profile_id)).limit(1);
        if (profRows[0]) {
          const data = parseData(profRows[0].data);
          const prep = { ...data.preparation };
          const errors = { ...data.preparation_errors };
          // Queuing a (re)try clears that item's failed state and reason
          // (D-03 retry path).
          if (args.kind === "image_generation") { prep.image = "pending"; errors.image = null; }
          if (args.kind === "link_summary") { prep.link_summary = "pending"; errors.link_summary = null; }
          if (args.kind === "trial_conversation") { prep.greeting = "pending"; errors.greeting = null; }
          prep.status =
            prep.image === "failed" || prep.link_summary === "failed" || prep.greeting === "failed"
              ? "needs_attention"
              : "preparing";
          data.preparation = prep;
          data.preparation_errors = errors;
          await db.update(schema.profiles).set({ data: JSON.stringify(data), updatedAt: now }).where(eq(schema.profiles.id, args.profile_id));
        }
      }
      ctx.invalidateQueries();
      return {
        request_id: id,
        phrase:
          args.kind === "profile_apply" && profileName
            ? applyPhrase(profileName, id)
            : null,
      };
    },
  }),

  listGenerationRequests: defineAction({
    description:
      "Lists generation requests, optionally only open ones or only those for one profile, newest first.",
    request: z.object({
      only_open: z.boolean().default(false),
      profile_id: z.string().min(1).nullable().default(null),
      limit: z.number().int().positive().max(100).default(30),
    }),
    response: z.object({ requests: z.array(generationRequestOut) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let rows = await db
        .select()
        .from(schema.generationRequests)
        .orderBy(desc(schema.generationRequests.createdAt))
        .limit(200);
      if (args.profile_id)
        rows = rows.filter((r) => r.profileId === args.profile_id);
      if (args.only_open)
        rows = rows.filter(
          (r) => r.status === "pending" || r.status === "processing",
        );
      rows = rows.slice(0, args.limit);
      const requests = await Promise.all(rows.map((r) => toGenOut(ctx, r)));
      return { requests };
    },
  }),

  completeGenerationRequest: defineAction({
    description:
      "Writes back a generation request result, field-scoped to the request kind (other profile fields and edits made in the meantime are preserved, D-02/R-12). For link_summary, result JSON {summary, unreadable_links} is applied; for image_generation, result JSON {file, blob_key, source} is appended to the images; for trial_conversation the greeting text is stored. CR-06: link_summary / trial_conversation results may also carry structured speech fields — flat keys (first_person, second_person, call_user_as, catchphrase, memo, style) or a nested speech/speech_structured object — which are stored as auto-generated values; fields the user set manually (speech.sources = manual) are never overwritten. CR-08: those results may also carry flavor traits (flavor_traits, flavor.traits, or traits: [{label, examples[], scenes[], enabled}]). CR-20: flavor write-backs MERGE into the existing auto traits instead of replacing them — a trait whose label matches an existing auto trait is updated on top of it (examples union-merged; scenes/enabled/frequency keep the stored values), a new label is added as a new auto trait, and auto traits absent from the write-back are kept; manual flavor traits are kept exactly and the flavor level never changes. For profile_apply (CR-03), result JSON may carry only {candidate_id, image_ref} (image_ref also accepted as image_base.image_ref) — those two fields alone are written back and everything else is preserved; a failed profile_apply touches no profile field. CR-12: for flavor_examples, the result carries example lines per trait — {examples_by_trait: {<trait id>: [lines]}} (flavor_examples in the same shape, or a traits-style array, are also accepted) — and each line set is stored on its trait ONLY if that trait still has no examples (examples the user typed in the meantime win and are never overwritten); a failed flavor_examples touches no profile field and no preparation item. A link_summary / trial_conversation write-back that creates auto flavor traits with auto_examples on and no examples queues a flavor_examples request for them. On failed (other kinds), only that kind's preparation item flips to failed and the reason is stored on the profile (preparation_errors) so the UI can show it with a retry path (D-03). CR-17: for video_transcript, the result is {video_notes, catchphrases[], unreadable_videos[]} — video_notes is stored on background.video_notes, catchphrases and any other speech fields in the result are applied as auto tone material (manual speech fields are never overwritten, CR-06 rule), unreadable_videos are recorded on the profile, and every current video URL is marked attempted (video_processed_urls). CR-20: link_summary / trial_conversation speech write-backs follow the same merge rules as video_transcript (see CR-18 below), and video_transcript results may also carry flavor_traits, applied with the CR-20 flavor merge. CR-18: video_transcript speech write-backs MERGE with existing auto fields instead of replacing them — catchphrase is union-merged (stored items kept, new candidates appended, deduplicated, joined with '／'), first_person / second_person are filled only when currently unset (an existing value is never overwritten), and memo / style in the result are treated as text already integrated with the existing tone (the request payload's note instructs the chat side to return them that way) and applied to the auto field as returned. A completed batch where every video was unreadable and no notes were produced flips the video preparation item to failed with the unreadable list as the reason; a failed video_transcript flips only the video item to failed with the reason — in both cases the profile itself and all other fields stay untouched and the profile remains usable. Write-backs for trashed profiles are recorded on the request only. CR-21: completed link_summary / video_transcript write-backs also record a portrayal verdict against the profile's current portrayal_focus (background.portrayal_focus_checks): result portrayal_focus_no_match: true (with portrayal_focus_no_match_reason) records a no_match for that kind; otherwise a completed link_summary records a match, and a video_transcript records a match when it produced video_notes (an all-unreadable batch with no notes records nothing unless the flag is present). The derived background.portrayal_focus_status is ok when any recorded check matched, failed when at least one check completed and all recorded checks are no_match (the latest reason is kept in portrayal_focus_failure_reason), and unknown otherwise. The verdict never alters content: a no-match write-back's summary/video_notes are stored exactly as returned (under the CR-21 contract they are built from all material), and the preparation state is untouched — a failed bias does not make the profile 要対応 and it stays ready/usable. While failed, the bias is inactive for switch output and every payload until a later check records a match. CR-21 addendum guard: when a result carries portrayal_focus_no_match, a summary / video_notes field that is missing — or that is just the bare 'no matching material' notice sentence — never overwrites the stored link_summary / video_notes; the stored full content is kept (only the verdict is recorded). CR-21 addendum 2: for link_summary / video_transcript requests whose payload carries the avatar_memory_repair marker (queued by updateProfile when portrayal_focus was removed), a completed result that returns a non-empty avatar_memory replaces the stored avatar_memory (the repaired text: specification-derived elements removed, other facts kept); a result without avatar_memory — or with an empty one — leaves the stored memory exactly as it was, and write-backs of non-repair requests never touch avatar_memory at all.",
    request: z.object({
      request_id: z.string().min(1),
      status: z.enum(["processing", "completed", "failed"]),
      result: z.string().max(50000).nullable().default(null),
      reason: z.string().max(1000).nullable().default(null),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.generationRequests)
        .where(eq(schema.generationRequests.id, args.request_id))
        .limit(1);
      const req = rows[0];
      if (!req) throw new Error("生成リクエストが見つかりません。");
      const now = new Date();
      await db
        .update(schema.generationRequests)
        .set({
          status: args.status,
          result: args.result,
          reason: args.reason,
          updatedAt: now,
        })
        .where(eq(schema.generationRequests.id, args.request_id));
      if (req.profileId && (args.status === "completed" || args.status === "failed")) {
        let parsed: Record<string, unknown> = {};
        if (args.result) {
          try {
            parsed = JSON.parse(args.result) as Record<string, unknown>;
          } catch {
            // trial_conversation may return plain text
            if (req.kind === "trial_conversation") parsed = { greeting: args.result };
          }
        }
        // CR-21 addendum 2: only a request queued as a portrayal_focus
        // removal repair (its payload carries the marker) may replace
        // avatar_memory through its write-back.
        const memoryRepairRequested = requestHasMemoryRepair(req.payload);
        const prof = await db
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.id, req.profileId))
          .limit(1);
        // Write-backs for a trashed profile are recorded on the request
        // only; they must not rewrite the deleted profile's data (R-12).
        if (prof[0] && !prof[0].deletedAt && req.kind === "profile_apply") {
          // CR-03 profile_apply write-back: ONLY candidate_id and
          // image_ref may change (the chat side applied name/speech/call
          // live; the image set result comes back as these two fields).
          // Every other field keeps its current stored value, and a
          // failed apply touches nothing on the profile.
          if (args.status === "completed") {
            const data = parseData(prof[0].data);
            if (
              typeof parsed.candidate_id === "string" &&
              parsed.candidate_id
            ) {
              data.candidate_id = parsed.candidate_id.slice(0, 500);
            }
            const baseObj =
              parsed.image_base && typeof parsed.image_base === "object"
                ? (parsed.image_base as Record<string, unknown>)
                : null;
            const refRaw =
              typeof parsed.image_ref === "string"
                ? parsed.image_ref
                : baseObj && typeof baseObj.image_ref === "string"
                  ? baseObj.image_ref
                  : null;
            if (refRaw) {
              data.image_base = {
                ...data.image_base,
                type: "image",
                image_ref: refRaw.slice(0, 2000),
              };
            }
            await db
              .update(schema.profiles)
              .set({
                data: JSON.stringify(withPreparation(data)),
                updatedAt: now,
              })
              .where(eq(schema.profiles.id, req.profileId));
          }
        } else if (
          prof[0] &&
          !prof[0].deletedAt &&
          req.kind !== "flavor_examples" &&
          req.kind !== "video_transcript"
        ) {
          // Field-scoped write-back (D-02/R-12): start from the profile's
          // CURRENT stored data (re-read above, so edits made while the
          // request was in flight survive) and touch only this kind's own
          // fields plus its own preparation item.
          const data = parseData(prof[0].data);
          const kindKey =
            req.kind === "image_generation"
              ? "image"
              : req.kind === "link_summary"
                ? "link_summary"
                : "greeting";
          if (args.status === "completed") {
            // CR-06: a link_summary / trial_conversation write-back may
            // carry structured speech fields (flat or nested in the
            // result JSON). They are applied as "auto" values, and
            // fields the user marked "manual" are never overwritten.
            if (req.kind === "link_summary" || req.kind === "trial_conversation") {
              // CR-20: speech write-backs now follow the SAME merge
              // rules CR-18 gave video_transcript — catchphrase is
              // union-merged, first/second person fill only when unset,
              // memo/style are applied as text already integrated with
              // the existing tone. Manual fields stay untouchable.
              const speechUpdates = extractSpeechUpdates(parsed);
              if (Object.keys(speechUpdates).length > 0) {
                const applied = applyMergedAutoSpeechFields(data, speechUpdates);
                data.speech = applied.speech;
                data.call_user_as = applied.call_user_as;
              }
              // CR-08 + CR-20: the write-back may also carry inferred
              // flavor traits (flavor_traits / flavor.traits / traits).
              // They are MERGED into the existing auto traits (see
              // applyAutoFlavorTraits); manual traits are kept exactly,
              // auto traits absent from the write-back survive, and the
              // level never changes.
              const flavorUpdates = extractFlavorTraits(parsed);
              if (flavorUpdates.length > 0) {
                data.flavor = applyAutoFlavorTraits(data, flavorUpdates).flavor;
              }
            }
            if (req.kind === "link_summary") {
              // CR-21: this check's portrayal verdict (see the record
              // call below). Computed first because it also drives the
              // storage guard on the summary.
              const verdict = extractPortrayalVerdict(parsed);
              // Truncate to the profile schema limits: an over-long
              // write-back would make the next parseData throw and fall
              // back to all-defaults, wiping every field (D-02 class).
              // CR-21 addendum guard: when the write-back reports
              // no-match, its summary is stored as the full-material
              // content — but if the summary field is missing (the
              // typeof check) or is just the bare "no material" notice
              // sentence, the stored summary is KEPT instead of being
              // overwritten by the notice (the pre-CR-21 data loss).
              if (typeof parsed.summary === "string") {
                if (
                  !(
                    verdict.noMatch &&
                    isPortrayalNoMatchNotice(parsed.summary)
                  )
                ) {
                  data.background.link_summary = parsed.summary.slice(0, 5000);
                }
              }
              if (Array.isArray(parsed.unreadable_links)) {
                data.background.unreadable_links = parsed.unreadable_links
                  .filter((u): u is string => typeof u === "string")
                  .map((u) => u.slice(0, 2000))
                  .slice(0, 20);
              }
              // CR-21: record the verdict. Under the CR-21 contract a
              // no-match write-back still carries the full-material
              // summary (stored above, exactly as returned) plus
              // portrayal_focus_no_match /
              // portrayal_focus_no_match_reason; the verdict only moves
              // the check state, never the content.
              recordPortrayalCheck(
                data,
                "link_summary",
                verdict.noMatch ? "no_match" : "match",
                verdict.reason,
              );
              // CR-21 addendum 2: avatar_memory repair — when this
              // request was queued by a portrayal_focus removal and
              // the write-back returns a (non-empty) avatar_memory,
              // it replaces the stored memory (the chat side removed
              // the specification-derived elements and kept the other
              // facts). No returned avatar_memory — or an empty one —
              // keeps the stored memory exactly as it was.
              if (
                memoryRepairRequested &&
                typeof parsed.avatar_memory === "string" &&
                parsed.avatar_memory.trim()
              ) {
                data.avatar_memory = parsed.avatar_memory
                  .trim()
                  .slice(0, 20000);
              }
            }
            if (req.kind === "image_generation") {
              const file =
                typeof parsed.file === "string" ? parsed.file : null;
              const blobKey =
                typeof parsed.blob_key === "string" ? parsed.blob_key : null;
              if (file || blobKey) {
                const first = data.images.length === 0;
                data.images = [
                  ...data.images.map((img) => ({
                    ...img,
                    is_primary: first ? false : img.is_primary,
                  })),
                  {
                    id: newId("im"),
                    file: file ?? blobKey ?? "",
                    blob_key: blobKey,
                    is_primary: first,
                    source:
                      typeof parsed.source === "string"
                        ? parsed.source
                        : "generated",
                  },
                ];
                data.image_base = {
                  ...data.image_base,
                  type: "image",
                  image_ref: blobKey ?? file ?? data.image_base.image_ref,
                };
                // CR-10: a generated image may report its dominant
                // color as theme_color in the result; it becomes the
                // theme color (auto) unless the user set it manually.
                if (
                  typeof parsed.theme_color === "string" &&
                  isValidThemeColor(parsed.theme_color) &&
                  data.theme_color_source !== "manual"
                ) {
                  data.theme_color = parsed.theme_color.toLowerCase();
                  data.theme_color_source = "auto";
                }
              }
            }
            if (req.kind === "trial_conversation") {
              const greetingText =
                (typeof parsed.greeting === "string" && parsed.greeting) ||
                (typeof parsed.text === "string" && parsed.text) ||
                (typeof parsed.trial_text === "string" && parsed.trial_text) ||
                (typeof parsed.greeting_text === "string" && parsed.greeting_text) ||
                "";
              if (greetingText) {
                // Schema limit (greeting max 5000) — see link_summary note.
                data.greeting = greetingText.slice(0, 5000);
              } else if (args.result && !args.result.trim().startsWith("{")) {
                data.greeting = args.result.slice(0, 5000);
              }
            }
            // Mark only this kind's item done (or none when it no longer
            // applies) and clear its stored failure reason.
            if (kindKey === "image") {
              data.preparation.image =
                data.image_base.type === "none" ? "none" : "done";
              data.preparation_errors.image = null;
            } else if (kindKey === "link_summary") {
              data.preparation.link_summary =
                data.background.links.length === 0 ? "none" : "done";
              data.preparation_errors.link_summary = null;
            } else {
              data.preparation.greeting = data.greeting ? "done" : "pending";
              data.preparation_errors.greeting = null;
            }
          } else {
            // Failed (D-03): only this kind's item flips to failed and the
            // reason is stored on the profile so list/detail can show it
            // with a retry path. Content fields stay exactly as they were.
            const reason = args.reason ?? "理由が記録されませんでした。";
            if (kindKey === "image") {
              data.preparation.image = "failed";
              data.preparation_errors.image = reason;
            } else if (kindKey === "link_summary") {
              data.preparation.link_summary = "failed";
              data.preparation_errors.link_summary = reason;
            } else {
              data.preparation.greeting = "failed";
              data.preparation_errors.greeting = reason;
            }
          }
          const recomputed = withPreparation(data);
          data.preparation = recomputed.preparation;
          data.preparation_errors = recomputed.preparation_errors;
          if (args.status === "completed") {
            // The completion itself is authoritative for its own item even
            // where the content heuristic would demote it (e.g. an image
            // generation accepted without a file payload).
            if (kindKey === "image" && data.image_base.type !== "none")
              data.preparation.image = "done";
            if (kindKey === "link_summary")
              data.preparation.link_summary =
                data.background.links.length === 0 ? "none" : "done";
            if (kindKey === "greeting" && data.greeting)
              data.preparation.greeting = "done";
            data.preparation.status =
              data.preparation.image === "failed" ||
              data.preparation.link_summary === "failed" ||
              data.preparation.greeting === "failed"
                ? "needs_attention"
                : data.preparation.image === "pending" ||
                    data.preparation.link_summary === "pending" ||
                    data.preparation.greeting === "pending"
                  ? "preparing"
                  : "ready";
          }
          await db
            .update(schema.profiles)
            .set({ data: JSON.stringify(data), updatedAt: now })
            .where(eq(schema.profiles.id, req.profileId));
          // CR-12: a link_summary / trial_conversation write-back may
          // have just created auto flavor traits (auto_examples on by
          // default in the full-auto flow) that still have no examples —
          // queue their example generation right away.
          if (
            args.status === "completed" &&
            (req.kind === "link_summary" || req.kind === "trial_conversation")
          ) {
            await queueFlavorExamplesRequest(ctx, req.profileId, prof[0].name, data);
          }
        } else if (prof[0] && !prof[0].deletedAt && req.kind === "flavor_examples") {
          // CR-12 flavor_examples write-back: store the generated
          // example lines on their target traits. Manual priority: a
          // trait the user has since filled with their own examples is
          // never overwritten. The trait's source and every other
          // profile field stay untouched, and a failed request changes
          // nothing (there is no preparation item for this kind).
          if (args.status === "completed") {
            const data = parseData(prof[0].data);
            const byTrait = extractFlavorExamples(parsed, data);
            if (byTrait.size > 0) {
              const flavor = data.flavor ?? emptyFlavor;
              data.flavor = {
                level: flavor.level,
                traits: flavor.traits.map((t) => {
                  const lines = byTrait.get(t.id);
                  if (!lines) return t;
                  if (t.examples.some((e) => e.trim())) return t;
                  return { ...t, examples: lines };
                }),
              };
              await db
                .update(schema.profiles)
                .set({
                  data: JSON.stringify(withPreparation(data)),
                  updatedAt: now,
                })
                .where(eq(schema.profiles.id, req.profileId));
            }
          }
        } else if (prof[0] && !prof[0].deletedAt && req.kind === "video_transcript") {
          // CR-17 video_transcript write-back. Expected result shape:
          // {"video_notes": "台詞から読み取れた口調の特徴の要約",
          //  "catchphrases": ["決まり文句の候補", ...],
          //  "unreadable_videos": ["取得できなかったURL", ...]}.
          // video_notes is stored on background.video_notes. Tone
          // material (catchphrases and any other speech fields the
          // result carries, flat or nested) is applied through the
          // CR-06 auto path — fields whose source is "manual" are never
          // overwritten — with the CR-18 merge rules on top: catchphrase
          // is union-merged with the stored value, first/second person
          // fill only when unset, and memo/style are applied as the
          // integrated text the chat side returns (see below).
          // Every current video URL counts as attempted by this batch
          // (video_processed_urls), so an unrelated later save never
          // auto-requeues it. On failed, only the video preparation
          // item flips to failed with the reason — the profile itself
          // (and every content field) stays exactly as it was and
          // remains usable.
          const data = parseData(prof[0].data);
          const currentUrls = normalizeVideoUrls(data.background.video_urls);
          const cleanUnreadable = (v: unknown): string[] =>
            Array.isArray(v)
              ? v
                  .filter((u): u is string => typeof u === "string")
                  .map((u) => u.trim().slice(0, 2000))
                  .filter(Boolean)
                  .slice(0, 20)
              : [];
          if (args.status === "completed") {
            // CR-21: this batch's portrayal verdict — computed first
            // because it also drives the storage guard on video_notes.
            const verdict = extractPortrayalVerdict(parsed);
            // CR-21 addendum guard: when the write-back reports
            // no-match, video_notes is stored as the full-material
            // content — but if the field is missing, or is just the
            // bare "no matching segment" notice sentence, the stored
            // notes are KEPT instead of being overwritten by the
            // notice (the pre-CR-21 data loss).
            if (
              typeof parsed.video_notes === "string" &&
              parsed.video_notes.trim() &&
              !(
                verdict.noMatch &&
                isPortrayalNoMatchNotice(parsed.video_notes)
              )
            ) {
              // Schema limit (video_notes max 5000) — see link_summary.
              data.background.video_notes = parsed.video_notes
                .trim()
                .slice(0, 5000);
            }
            const unreadable = cleanUnreadable(parsed.unreadable_videos);
            data.background.unreadable_videos = unreadable;
            // Tone material from the dialogue — CR-18 merge rules via
            // the shared CR-20 helper (auto / unset speech fields only;
            // manual fields stay protected): catchphrase is
            // union-merged (the catchphrases[] list plus any catchphrase
            // string in the result), first/second person fill only when
            // unset, memo/style are applied as the integrated text the
            // chat side returns.
            const speechUpdates = extractSpeechUpdates(parsed);
            const catchphraseCandidates: string[] = [];
            if (Array.isArray(parsed.catchphrases)) {
              for (const c of parsed.catchphrases) {
                if (typeof c === "string" && c.trim())
                  catchphraseCandidates.push(c.trim());
              }
            }
            {
              const applied = applyMergedAutoSpeechFields(
                data,
                speechUpdates,
                catchphraseCandidates,
              );
              data.speech = applied.speech;
              data.call_user_as = applied.call_user_as;
            }
            // CR-20: flavor can now be re-inferred from the videos too
            // — a completed result may carry flavor_traits (or
            // flavor.traits), applied with the same merge rules as
            // every other flavor write-back.
            const videoFlavorUpdates = extractFlavorTraits(parsed);
            if (videoFlavorUpdates.length > 0) {
              data.flavor = applyAutoFlavorTraits(data, videoFlavorUpdates).flavor;
            }
            data.background.video_processed_urls = [...currentUrls];
            // CR-21: record this batch's portrayal verdict. Under the
            // CR-21 contract a no-match write-back still carries
            // video_notes built from the whole transcript (stored
            // above) plus portrayal_focus_no_match /
            // portrayal_focus_no_match_reason. A batch that produced
            // notes counts as evaluated; a batch where every video was
            // unreadable and no notes exist never got to judge the
            // portrayal at all, so it records a verdict ONLY when the
            // result explicitly carries the no-match flag.
            {
              const producedNotes = !!(
                typeof parsed.video_notes === "string" &&
                parsed.video_notes.trim()
              );
              if (verdict.noMatch) {
                recordPortrayalCheck(
                  data,
                  "video_transcript",
                  "no_match",
                  verdict.reason,
                );
              } else if (producedNotes) {
                recordPortrayalCheck(data, "video_transcript", "match", null);
              }
            }
            // CR-21 addendum 2: avatar_memory repair — same rule as
            // the link_summary write-back: a repair request whose
            // result returns a non-empty avatar_memory replaces the
            // stored memory (specification-derived elements removed,
            // other facts kept); no returned value keeps it untouched.
            if (
              memoryRepairRequested &&
              typeof parsed.avatar_memory === "string" &&
              parsed.avatar_memory.trim()
            ) {
              data.avatar_memory = parsed.avatar_memory
                .trim()
                .slice(0, 20000);
            }
            // Preparation outcome: every video unreadable and no notes
            // at all means the batch produced nothing — that is a
            // failure the user must see (with the unreadable list as
            // the reason). A partially readable batch is done; its
            // unreadable_videos stay on file and are shown on the
            // detail screen next to the video state.
            const allUnreadable =
              currentUrls.length > 0 &&
              currentUrls.every((u) =>
                unreadable.some((e) => e === u || e.startsWith(u)),
              );
            const hasNotes = !!(
              data.background.video_notes &&
              data.background.video_notes.trim()
            );
            if (allUnreadable && !hasNotes) {
              data.preparation = { ...data.preparation, video: "failed" };
              data.preparation_errors = {
                ...data.preparation_errors,
                video:
                  `動画の文字起こしを取得できませんでした: ${unreadable.join("、")}`.slice(
                    0,
                    1000,
                  ),
              };
            } else {
              data.preparation = {
                ...data.preparation,
                video: currentUrls.length > 0 ? "done" : "none",
              };
              data.preparation_errors = {
                ...data.preparation_errors,
                video: null,
              };
            }
          } else {
            // Failed: only the video item flips, with the reason.
            const unreadable = cleanUnreadable(parsed.unreadable_videos);
            if (unreadable.length > 0) {
              data.background.unreadable_videos = unreadable;
            }
            data.background.video_processed_urls = [...currentUrls];
            data.preparation = { ...data.preparation, video: "failed" };
            data.preparation_errors = {
              ...data.preparation_errors,
              video: args.reason ?? "理由が記録されませんでした。",
            };
          }
          await db
            .update(schema.profiles)
            .set({
              data: JSON.stringify(withPreparation(data)),
              updatedAt: now,
            })
            .where(eq(schema.profiles.id, req.profileId));
          // CR-20 + CR-12: a video write-back may have just created
          // auto flavor traits that still have no examples — queue
          // their example generation like link/trial write-backs do.
          if (args.status === "completed") {
            await queueFlavorExamplesRequest(ctx, req.profileId, prof[0].name, data);
          }
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteGenerationRequest: defineAction({
    description:
      "CR-15: Discards one generation request from the request lists. Only pending, processing, or failed requests can be deleted; a completed request is kept as history and this action rejects it. Deleting an open profile_apply request drops the target profile's pending-apply count (and its 反映待ち badge). When the deleted request was the last open one of its kind, a stale preparation hint left by it is cleared so the profile's preparation is re-derived from its actual content (a dismissed failure no longer shows as 要対応; a discarded link-summary requeue with an existing summary returns to done). The profile's content fields and all other requests are untouched.",
    request: z.object({ request_id: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.generationRequests)
        .where(eq(schema.generationRequests.id, args.request_id))
        .limit(1);
      const req = rows[0];
      if (!req) throw new Error("生成リクエストが見つかりません。");
      if (req.status === "completed")
        throw new Error("完了済みのリクエストは消去できません。");
      const deletedStatus = req.status;
      await db
        .delete(schema.generationRequests)
        .where(eq(schema.generationRequests.id, args.request_id));
      // Preparation-hint cleanup (see description): profile_apply and
      // flavor_examples have no preparation item, so they end here —
      // their pending counts are derived from the rows themselves.
      const kindKey =
        req.kind === "image_generation"
          ? ("image" as const)
          : req.kind === "link_summary"
            ? ("link_summary" as const)
            : req.kind === "trial_conversation"
              ? ("greeting" as const)
              : req.kind === "video_transcript"
                ? ("video" as const)
                : null;
      if (req.profileId && kindKey) {
        const remaining = await db
          .select({ status: schema.generationRequests.status })
          .from(schema.generationRequests)
          .where(
            and(
              eq(schema.generationRequests.profileId, req.profileId),
              eq(schema.generationRequests.kind, req.kind),
            ),
          );
        const stillOpen = remaining.some(
          (r) => r.status === "pending" || r.status === "processing",
        );
        if (!stillOpen) {
          const prof = await db
            .select()
            .from(schema.profiles)
            .where(eq(schema.profiles.id, req.profileId))
            .limit(1);
          if (prof[0] && !prof[0].deletedAt) {
            const data = parseData(prof[0].data);
            let changed = false;
            if (
              deletedStatus === "failed" &&
              data.preparation[kindKey] === "failed"
            ) {
              // Dismissing the failed request also dismisses the sticky
              // failure: reset the stored hint to neutral and let
              // withPreparation re-derive the item from real content.
              data.preparation = { ...data.preparation, [kindKey]: "none" };
              data.preparation_errors = {
                ...data.preparation_errors,
                [kindKey]: null,
              };
              changed = true;
            } else if (
              (deletedStatus === "pending" || deletedStatus === "processing") &&
              kindKey === "link_summary" &&
              data.preparation.link_summary === "pending" &&
              data.background.link_summary &&
              data.background.link_summary.trim()
            ) {
              // A discarded re-summary request must not leave the profile
              // stuck at 準備中 when a summary is already on file.
              data.preparation = { ...data.preparation, link_summary: "none" };
              changed = true;
            } else if (
              (deletedStatus === "pending" || deletedStatus === "processing") &&
              kindKey === "video" &&
              data.preparation.video === "pending" &&
              data.background.video_notes &&
              data.background.video_notes.trim()
            ) {
              // CR-17: same as link_summary — discarding a re-processing
              // request must not leave the video item stuck at 準備中
              // when transcript findings are already on file.
              data.preparation = { ...data.preparation, video: "none" };
              changed = true;
            }
            if (changed) {
              await db
                .update(schema.profiles)
                .set({
                  data: JSON.stringify(withPreparation(data)),
                  updatedAt: new Date(),
                })
                .where(eq(schema.profiles.id, req.profileId));
            }
          }
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // -- Export / import ----------------------------------------------------------

  exportProfile: defineAction({
    description:
      "Exports a profile as avatar-profile v1.0 JSON text. include_personal defaults to true so a plain export is lossless (call_user_as and avatar_memory included — D-01); pass false explicitly to leave personal fields out (N-04 choice).",
    request: z.object({
      id: z.string().min(1),
      include_personal: z.boolean().default(true),
    }),
    response: z.object({ json: z.string(), filename: z.string() }),
    async handler(ctx, args) {
      const row = await getRow(ctx, args.id);
      const out = await toProfileOut(ctx, row);
      const exported: Record<string, unknown> = {
        format: out.format,
        format_version: out.format_version,
        id: out.id,
        name: out.name,
        summary: out.summary,
        greeting: out.greeting,
        preparation: out.preparation,
        preparation_errors: out.preparation_errors,
        background: out.background,
        images: out.images.map((img) => ({
          id: img.id,
          file: img.file,
          blob_key: img.blob_key,
          is_primary: img.is_primary,
          source: img.source,
        })),
        image_base: out.image_base,
        call_user_as: args.include_personal ? out.call_user_as : null,
        speech: out.speech,
        flavor: out.flavor,
        theme_color: out.theme_color,
        theme_color_source: out.theme_color_source,
        voice: out.voice,
        avatar_memory: args.include_personal ? out.avatar_memory : "",
        switch_settings: {
          pass_conversation_summary: false,
          use_shared_info: out.switch_settings.use_shared_info,
        },
        origin: out.origin,
        candidate_id: out.candidate_id,
        favorite: out.favorite,
        created_at: out.created_at,
        updated_at: out.updated_at,
        last_used_at: out.last_used_at,
      };
      const safeName = out.name.replace(/[\\/:*?"<>|]/g, "_");
      return {
        json: JSON.stringify(exported, null, 2),
        filename: `avatar-profile-${safeName}.json`,
      };
    },
  }),

  importProfile: defineAction({
    description:
      "Imports an avatar-profile JSON text as a new profile (new id; embedded blob images are kept as file references). CR-16: voice.reserved is accepted as false or true on import and normalized to true on save (it is only a reservation flag for a future voice feature); all other validation stays strict.",
    request: z.object({ json: z.string().min(2).max(2_000_000) }),
    response: z.object({ id: z.string(), name: z.string() }),
    async handler(ctx, args) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(args.json) as Record<string, unknown>;
      } catch {
        throw new Error("JSONとして読み取れませんでした。");
      }
      if (raw.format !== "avatar-profile")
        throw new Error("avatar-profile 形式のファイルではありません。");
      const name =
        typeof raw.name === "string" && raw.name.trim()
          ? raw.name.trim().slice(0, 100)
          : "読み込んだアバター";
      // CR-16: normalize voice.reserved on the import path only. Other
      // environments export reserved:false; the flag's value does not
      // change the profile's meaning, so accept both booleans (or a
      // missing flag, which defaults as before) and store true.
      // Anything else — a non-object voice, or a reserved value that is
      // not a boolean — is passed through untouched so the strict
      // profileDataSchema validation still rejects it.
      const rawVoice = raw.voice;
      const rawReserved =
        rawVoice != null &&
        typeof rawVoice === "object" &&
        !Array.isArray(rawVoice)
          ? (rawVoice as Record<string, unknown>).reserved
          : undefined;
      const voiceForImport =
        rawVoice == null
          ? { reserved: true as const, kind: null, speed: null }
          : typeof rawVoice === "object" &&
              !Array.isArray(rawVoice) &&
              (rawReserved === undefined ||
                typeof rawReserved === "boolean")
            ? {
                ...(rawVoice as Record<string, unknown>),
                reserved: true as const,
              }
            : rawVoice;
      const data = profileDataSchema.parse({
        summary: raw.summary ?? "",
        greeting: typeof raw.greeting === "string" ? raw.greeting : "",
        preparation: raw.preparation ?? undefined,
        preparation_errors: raw.preparation_errors ?? undefined,
        background: raw.background ?? {
          text: "",
          links: [],
          link_summary: null,
          unreadable_links: [],
        },
        images: Array.isArray(raw.images) ? raw.images : [],
        image_base: raw.image_base ?? {
          type: "none",
          image_ref: null,
          elements: {},
        },
        call_user_as: raw.call_user_as ?? null,
        speech: raw.speech ?? { style: null, inferred: false, tuning: {} },
        flavor: raw.flavor ?? { level: 3, traits: [] },
        theme_color: raw.theme_color ?? undefined,
        theme_color_source: raw.theme_color_source ?? undefined,
        voice: voiceForImport,
        avatar_memory: raw.avatar_memory ?? "",
        switch_settings: {
          pass_conversation_summary: false,
          use_shared_info:
            (raw.switch_settings as { use_shared_info?: boolean } | undefined)
              ?.use_shared_info ?? true,
        },
        origin: { type: "imported", chat_link: null },
        candidate_id: raw.candidate_id ?? null,
      });
      const id = await insertProfile(ctx, name, data, {
        favorite: raw.favorite === true,
      });
      ctx.invalidateQueries();
      return { id, name };
    },
  }),

  // -- Summary / seed -----------------------------------------------------------

  getSummary: defineAction({
    description:
      "Dashboard summary for this app: profile count, active avatar name, latest last-used time, pending request counts, and status. pending_generation_count counts every open generation request, including profile_apply (CR-03).",
    request: z.object({}),
    response: z.object({
      status: z.string(),
      profile_count: z.number(),
      active_profile_id: z.string().nullable(),
      active_name: z.string().nullable(),
      last_used_at: z.string().nullable(),
      pending_switch_count: z.number(),
      pending_generation_count: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.profiles)
        .where(isNull(schema.profiles.deletedAt));
      const active = rows.find((r) => r.isActive);
      const lastUsed = rows
        .map((r) => r.lastUsedAt)
        .filter((d): d is Date => d != null)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      const sw = await db.select().from(schema.switchRequests);
      const gen = await db.select().from(schema.generationRequests);
      return {
        status: "稼働中",
        profile_count: rows.length,
        active_profile_id: active?.id ?? null,
        active_name: active?.name ?? null,
        last_used_at: lastUsed ? lastUsed.toISOString() : null,
        pending_switch_count: sw.filter(
          (r) => r.status === "pending" || r.status === "processing",
        ).length,
        pending_generation_count: gen.filter(
          (r) => r.status === "pending" || r.status === "processing",
        ).length,
      };
    },
  }),

  seedInitialProfiles: defineAction({
    description:
      "One-time seed hook. In this export build it seeds nothing (the original seed data was personal and is not published).",
    request: z.object({}),
    response: z.object({ seeded: z.boolean(), count: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .limit(1);
      if (existing.length > 0) return { seeded: false, count: 0 };

      // Export build: the original seed inserted the owner's real avatar
      // profiles. They are personal data and are not part of this
      // publication, so this action intentionally seeds nothing.
      return { seeded: false, count: 0 };
    },
  }),
} satisfies ActionsModule;
