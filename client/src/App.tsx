import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { api, type ApiResponse } from "./api";

const FIELDS = actionFields<typeof Actions>();

type Profile = ApiResponse<typeof api, "listProfiles">["profiles"][number];
type SwitchRequest = ApiResponse<
  typeof api,
  "listProfiles"
>["switch_requests"][number];
type GenRequest = ApiResponse<
  typeof api,
  "listGenerationRequests"
>["requests"][number];

type Elements = Profile["image_base"]["elements"];
type Tuning = Profile["speech"]["tuning"];
type SpeechSources = Profile["speech"]["sources"];
type SpeechSource = "auto" | "manual" | null;
type FlavorTrait = Profile["flavor"]["traits"][number];

// CR-08: フレーバー（キャラクターらしさ）の量バーの段階説明。
// 0=出さない、1〜2=ここぞの場面だけ、3=節目に自然に（既定）、4〜5=頻繁に。
export const FLAVOR_LEVEL_DESCRIPTIONS: Record<number, string> = {
  0: "出さない（用件だけの応対になります）",
  1: "ここぞの場面だけ（ごく控えめ）",
  2: "ここぞの場面だけ",
  3: "節目に自然に（既定）",
  4: "頻繁に出す",
  5: "頻繁に出す（強め）",
};

export const FLAVOR_SCENE_PRESETS = [
  "挨拶時",
  "完了時",
  "成功時",
  "失敗時",
  "ふだん",
] as const;

function newFlavorTraitId(): string {
  return `ft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// CR-14: per-trait frequency. frequency null/undefined = follow the
// global level; a number 0-5 overrides it for that trait only.
export function effectiveFlavorFrequency(
  trait: { frequency?: number | null },
  globalLevel: number,
): number {
  return trait.frequency ?? globalLevel;
}

export function flavorFrequencyIsCustom(
  trait: { frequency?: number | null },
  globalLevel: number,
): boolean {
  return trait.frequency != null && trait.frequency !== globalLevel;
}

export function FlavorEffectiveBadge({
  trait,
  globalLevel,
}: {
  trait: { frequency?: number | null };
  globalLevel: number;
}) {
  const eff = effectiveFlavorFrequency(trait, globalLevel);
  const custom = trait.frequency != null;
  const differs = custom && eff !== globalLevel;
  if (!custom) {
    return (
      <span
        className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold"
        style={{ border: "1px solid var(--border)", color: "var(--dim)" }}
      >
        頻度: 全体に従う（実効 {eff}/5）
      </span>
    );
  }
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-xs font-bold text-white"
      style={{ background: differs ? "var(--gold)" : "var(--teal)" }}
    >
      頻度: 個別 {eff}/5{differs ? `（全体 ${globalLevel} と異なる）` : "（個別設定）"}
    </span>
  );
}

// CR-10: テーマカラー — mirrors the server-side acquisition rules.
// "auto" = acquired from the representative image's dominant color
// (extractDominantColor below) or inferred from the appearance elements;
// "manual" = picked by the user (never overwritten by image changes);
// "default" = fallback when nothing could be acquired.
export const DEFAULT_THEME_COLOR = "#64748b";

type ThemeColorSource = "auto" | "manual" | "default";

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

export function deriveThemeColorFromElements(
  elements: Elements,
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

export function isValidThemeColor(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

// Extract an image's dominant color as #rrggbb. The image is drawn to a
// small canvas and pixels are bucketed by hue, weighted by saturation
// (near-gray / near-white / near-black pixels barely count), so the
// result is the character's main color rather than the background's.
// Cross-origin images without CORS taint the canvas; that (and any load
// failure) resolves to null and the caller falls back to the elements /
// default color.
export function extractDominantColor(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => resolve(null), 5000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const size = 40;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx2d) {
          resolve(null);
          return;
        }
        ctx2d.drawImage(img, 0, 0, size, size);
        const { data } = ctx2d.getImageData(0, 0, size, size);
        type Bucket = { r: number; g: number; b: number; w: number };
        const buckets = new Map<number, Bucket>();
        const fallback: Bucket = { r: 0, g: 0, b: 0, w: 0 };
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3] ?? 0;
          if (a < 128) continue;
          const r = data[i] ?? 0;
          const g = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          fallback.r += r;
          fallback.g += g;
          fallback.b += b;
          fallback.w += 1;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          if (sat < 0.18) continue;
          const d = mx - mn;
          let h = 0;
          if (d !== 0) {
            if (mx === r) h = ((g - b) / d) % 6;
            else if (mx === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
          }
          const bin = Math.floor(h / 30);
          const wgt = sat * (0.35 + 0.65 * (mx / 255));
          const bk = buckets.get(bin) ?? { r: 0, g: 0, b: 0, w: 0 };
          bk.r += r * wgt;
          bk.g += g * wgt;
          bk.b += b * wgt;
          bk.w += wgt;
          buckets.set(bin, bk);
        }
        let best: Bucket | null = null;
        for (const bk of buckets.values()) {
          if (!best || bk.w > best.w) best = bk;
        }
        let chosen: { r: number; g: number; b: number } | null = null;
        if (best && best.w > 0) {
          chosen = { r: best.r / best.w, g: best.g / best.w, b: best.b / best.w };
        } else if (fallback.w > 0) {
          chosen = {
            r: fallback.r / fallback.w,
            g: fallback.g / fallback.w,
            b: fallback.b / fallback.w,
          };
        }
        if (!chosen) {
          resolve(null);
          return;
        }
        let { r, g, b } = chosen;
        // Keep the color usable as a card border/band: clamp luminance
        // into a mid range (too light reads as no color, too dark as
        // black) while preserving the hue.
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if (lum > 0.68 && lum > 0) {
          const f = 0.68 / lum;
          r *= f;
          g *= f;
          b *= f;
        } else if (lum < 0.14) {
          const t = 0.25;
          r += (255 - r) * t;
          g += (255 - g) * t;
          b += (255 - b) * t;
        }
        const hex =
          "#" +
          [r, g, b]
            .map((v) =>
              Math.round(Math.max(0, Math.min(255, v)))
                .toString(16)
                .padStart(2, "0"),
            )
            .join("");
        resolve(hex);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = src;
  });
}

function ThemeSourceBadge({ source }: { source: ThemeColorSource }) {
  if (source === "manual") {
    return (
      <span
        className="inline-block rounded-full px-2 py-0.5 text-xs font-bold text-white"
        style={{ background: "var(--gold)" }}
      >
        手動指定
      </span>
    );
  }
  if (source === "auto") {
    return (
      <span
        className="inline-block rounded-full px-2 py-0.5 text-xs font-bold text-white"
        style={{ background: "var(--teal)" }}
      >
        自動取得
      </span>
    );
  }
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ border: "1px solid var(--border)", color: "var(--dim)" }}
    >
      既定色
    </span>
  );
}

export const ELEMENT_DEFS: { key: keyof Elements; presets: string[] }[] = [
  { key: "性別の印象", presets: ["男性的な印象", "女性的な印象", "中性的", "なし・不明"] },
  { key: "年齢層", presets: ["子ども", "若者", "成人", "中年", "高齢", "不明"] },
  { key: "髪型・髪色", presets: ["ショート", "ロング", "ポニーテール", "ツインテール", "黒", "茶", "金", "銀", "赤", "青", "なし（大きな口ひげ）"] },
  { key: "目の色", presets: ["黒", "茶", "青", "緑", "赤", "見えない"] },
  { key: "眼鏡・目の見え方", presets: ["なし", "眼鏡", "サングラス（反射で目が見えない）", "片眼鏡", "目が大きい", "目が細い"] },
  { key: "体型", presets: ["標準", "スリム", "がっしり", "小柄", "大柄", "卵型の丸い体に細く長い脚"] },
  { key: "服装", presets: ["カジュアル", "スーツ", "制服", "和装", "白衣（研究者風）", "赤い上着"] },
  { key: "頭部装飾", presets: ["なし", "帽子", "ヘッドギア帯", "リボン", "カチューシャ"] },
  { key: "持ち物・小物", presets: ["なし", "ステッキ", "本", "タブレット", "工具", "マイク"] },
  { key: "メインカラー", presets: ["赤", "青", "緑", "黄", "紫", "黒", "白", "ピンク"] },
  { key: "雰囲気・表情", presets: ["明るい笑顔", "穏やか", "クール", "威厳がある", "小さな閉じた笑み", "無表情"] },
  { key: "画風", presets: ["アニメ調", "リアル調", "3D CG調", "ドット絵", "水彩風", "厚塗り"] },
  { key: "背景", presets: ["白（固定）"] },
];

const IMAGE_NOTICE =
  "画像について: 既存作品のキャラクターそのものの複製や公式画像、実在の人物の再現は受け付けられない場合があります。見た目の要素（髪型・服装・雰囲気など）で指定したオリジナルなら作れます。画像が受け付けられなくても、プロファイル自体は画像「未設定」で保存できます。";

// CR-07: 「私の扱い」 preset chips. A chip simply fills the free-text
// field; complex relationships are written out as a sentence there.
export const USER_RELATIONSHIP_PRESETS = [
  "主人に当たる存在",
  "友達",
  "先輩",
  "後輩",
  "家族",
  "雇い主",
  "関わりが深い者の友人（体を借りている設定）",
] as const;

type FormState = {
  name: string;
  summary: string;
  greeting: string;
  favorite: boolean;
  bgText: string;
  bgLinks: string[];
  linkSummary: string;
  // CR-17: 参考動画URL (background.video_urls) — kept separate from the
  // reference links; the chat side fetches each video's transcript and
  // uses the dialogue as tone reference material.
  bgVideoUrls: string[];
  // CR-07: 「私の扱い」 (background.user_relationship) — optional.
  userRelationship: string;
  // CR-19: 「演じる姿・状況」 (background.portrayal_focus) — optional.
  // Empty = unused: no bias anywhere, exactly as before.
  portrayalFocus: string;
  callUserAs: string;
  speechStyle: string;
  speechInferred: boolean;
  // CR-06 structured speech fields + per-field source (auto/manual).
  speechFirstPerson: string;
  speechSecondPerson: string;
  speechCatchphrase: string;
  speechMemo: string;
  speechSources: SpeechSources;
  tuning: Tuning;
  // CR-08: フレーバー設定（量レベル＋項目リスト）。
  flavorLevel: number;
  flavorTraits: FlavorTrait[];
  // CR-10: テーマカラー（値＋出自 auto/manual/default）。
  themeColor: string;
  themeColorSource: ThemeColorSource;
  voiceKind: string;
  voiceSpeed: string;
  avatarMemory: string;
  // F-3: the avatar_memory revision as loaded with the profile. It is
  // sent back unchanged with the save; if a generation write-back
  // advanced the stored revision in the meantime, the server keeps
  // the newer stored memory instead of this form's stale text.
  avatarMemoryRevision: number;
  useSharedInfo: boolean;
  imageBaseType: "image" | "elements" | "none";
  imageRef: string;
  elements: Elements;
};

function emptyElements(): Elements {
  return {
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
  };
}

function emptyForm(): FormState {
  return {
    name: "",
    summary: "",
    greeting: "",
    favorite: false,
    bgText: "",
    bgLinks: [],
    linkSummary: "",
    bgVideoUrls: [],
    userRelationship: "",
    portrayalFocus: "",
    callUserAs: "",
    speechStyle: "",
    speechInferred: false,
    speechFirstPerson: "",
    speechSecondPerson: "",
    speechCatchphrase: "",
    speechMemo: "",
    speechSources: {
      first_person: null,
      second_person: null,
      call_user_as: null,
      catchphrase: null,
      memo: null,
      style: null,
    },
    tuning: { politeness: 3, brightness: 3, length: 3, emoji: 3, free_note: "" },
    flavorLevel: 3,
    flavorTraits: [],
    themeColor: DEFAULT_THEME_COLOR,
    themeColorSource: "default",
    voiceKind: "",
    voiceSpeed: "",
    avatarMemory: "",
    avatarMemoryRevision: 0,
    useSharedInfo: true,
    imageBaseType: "none",
    imageRef: "",
    elements: emptyElements(),
  };
}

function formFromProfile(p: Profile): FormState {
  return {
    name: p.name,
    summary: p.summary,
    greeting: p.greeting ?? "",
    favorite: p.favorite,
    bgText: p.background.text,
    bgLinks: [...p.background.links],
    linkSummary: p.background.link_summary ?? "",
    bgVideoUrls: [...(p.background.video_urls ?? [])],
    userRelationship: p.background.user_relationship ?? "",
    portrayalFocus: p.background.portrayal_focus ?? "",
    callUserAs: p.call_user_as ?? "",
    speechStyle: p.speech.style ?? "",
    speechInferred: p.speech.inferred,
    speechFirstPerson: p.speech.structured.first_person ?? "",
    speechSecondPerson: p.speech.structured.second_person ?? "",
    speechCatchphrase: p.speech.structured.catchphrase ?? "",
    speechMemo: p.speech.structured.memo ?? "",
    speechSources: { ...p.speech.sources },
    tuning: { ...p.speech.tuning },
    flavorLevel: p.flavor?.level ?? 3,
    flavorTraits: (p.flavor?.traits ?? []).map((t) => ({
      ...t,
      examples: [...t.examples],
      scenes: [...t.scenes],
      // CR-14: legacy traits have no frequency — normalize to null
      // (follow global).
      frequency: t.frequency ?? null,
    })),
    themeColor: isValidThemeColor(p.theme_color ?? "")
      ? (p.theme_color as string).toLowerCase()
      : DEFAULT_THEME_COLOR,
    themeColorSource: p.theme_color_source ?? "default",
    voiceKind: p.voice.kind ?? "",
    voiceSpeed: p.voice.speed ?? "",
    avatarMemory: p.avatar_memory,
    // F-3: hold the revision exactly as loaded (see FormState).
    avatarMemoryRevision: p.avatar_memory_revision ?? 0,
    useSharedInfo: p.switch_settings.use_shared_info,
    imageBaseType: p.image_base.type,
    imageRef: p.image_base.image_ref ?? "",
    elements: { ...emptyElements(), ...p.image_base.elements },
  };
}

function formToData(f: FormState, existing?: Profile) {
  return {
    summary: f.summary.trim(),
    greeting: f.greeting ?? "",
    preparation: existing?.preparation ?? {
      image: "none" as const,
      link_summary: "none" as const,
      greeting: "pending" as const,
      video: "none" as const,
      status: "preparing" as const,
    },
    background: {
      text: f.bgText,
      links: f.bgLinks.map((l) => l.trim()).filter(Boolean),
      link_summary: f.linkSummary.trim() ? f.linkSummary.trim() : null,
      unreadable_links: existing?.background.unreadable_links ?? [],
      user_relationship: f.userRelationship.trim()
        ? f.userRelationship.trim()
        : null,
      // CR-19: 「演じる姿・状況」 — free text, null when unused.
      portrayal_focus: f.portrayalFocus.trim()
        ? f.portrayalFocus.trim()
        : null,
      // CR-21: the portrayal check state is generation-managed (like
      // the video fields below) — carried through from the stored
      // profile untouched; the server resets it when the focus value
      // itself changes.
      portrayal_focus_status:
        existing?.background.portrayal_focus_status ?? "unknown",
      portrayal_focus_failure_reason:
        existing?.background.portrayal_focus_failure_reason ?? null,
      portrayal_focus_checks: existing?.background
        .portrayal_focus_checks ?? { link_summary: null, video_transcript: null },
      // CR-17: reference video URLs are user input; the transcript
      // findings (video_notes / unreadable_videos / processed marks)
      // are generation-managed and carried through from the stored
      // profile, exactly like unreadable_links.
      video_urls: f.bgVideoUrls.map((l) => l.trim()).filter(Boolean),
      video_notes: existing?.background.video_notes ?? null,
      unreadable_videos: existing?.background.unreadable_videos ?? [],
      video_processed_urls: existing?.background.video_processed_urls ?? [],
    },
    images: (existing?.images ?? []).map((img) => ({
      id: img.id,
      file: img.file,
      blob_key: img.blob_key,
      is_primary: img.is_primary,
      source: img.source,
    })),
    image_base: {
      type: f.imageBaseType,
      image_ref: f.imageRef.trim() ? f.imageRef.trim() : null,
      elements: f.elements,
    },
    call_user_as: f.callUserAs.trim() ? f.callUserAs.trim() : null,
    speech: {
      style: f.speechStyle.trim() ? f.speechStyle.trim() : null,
      inferred: f.speechInferred,
      tuning: f.tuning,
      structured: {
        first_person: f.speechFirstPerson.trim() ? f.speechFirstPerson.trim() : null,
        second_person: f.speechSecondPerson.trim() ? f.speechSecondPerson.trim() : null,
        catchphrase: f.speechCatchphrase.trim() ? f.speechCatchphrase.trim() : null,
        memo: f.speechMemo.trim() ? f.speechMemo.trim() : null,
      },
      // CR-06 sources: empty value -> no source; unchanged value -> the
      // stored source stands; a typed/changed value is manual (the form
      // also updates speechSources live while typing).
      sources: (() => {
        const resolve = (
          value: string,
          existingValue: string | null | undefined,
          formSource: SpeechSource,
          existingSource: SpeechSource | undefined,
        ): SpeechSource => {
          if (!value.trim()) return null;
          if (existing && (existingValue ?? "") === value.trim())
            return existingSource ?? formSource;
          return formSource ?? "manual";
        };
        return {
          first_person: resolve(f.speechFirstPerson, existing?.speech.structured.first_person, f.speechSources.first_person, existing?.speech.sources.first_person),
          second_person: resolve(f.speechSecondPerson, existing?.speech.structured.second_person, f.speechSources.second_person, existing?.speech.sources.second_person),
          call_user_as: resolve(f.callUserAs, existing?.call_user_as, f.speechSources.call_user_as, existing?.speech.sources.call_user_as),
          catchphrase: resolve(f.speechCatchphrase, existing?.speech.structured.catchphrase, f.speechSources.catchphrase, existing?.speech.sources.catchphrase),
          memo: resolve(f.speechMemo, existing?.speech.structured.memo, f.speechSources.memo, existing?.speech.sources.memo),
          style: resolve(f.speechStyle, existing?.speech.style, f.speechSources.style, existing?.speech.sources.style),
        };
      })(),
    },
    // CR-08: flavor — traits with an empty label are dropped; example /
    // scene lists are trimmed. Sources are carried through as recorded
    // in the form (edits flip a trait to manual in the editor itself).
    flavor: {
      level: Math.min(5, Math.max(0, Math.round(f.flavorLevel))),
      traits: f.flavorTraits
        .filter((t) => t.label.trim())
        .map((t) => ({
          id: t.id || newFlavorTraitId(),
          label: t.label.trim(),
          examples: t.examples.map((e) => e.trim()).filter(Boolean),
          scenes: t.scenes.map((s) => s.trim()).filter(Boolean),
          enabled: t.enabled,
          source: t.source,
          // CR-12: 「例文を自動作成」フラグ（手動追加の既定はオフ）。
          auto_examples: t.auto_examples ?? false,
          // CR-14: per-trait frequency — null = follow global.
          frequency:
            t.frequency == null
              ? null
              : Math.min(5, Math.max(0, Math.round(t.frequency))),
        })),
    },
    // CR-10: theme color — an invalid hex in the form falls back to the
    // default color/source so a save can never store a broken value.
    theme_color: isValidThemeColor(f.themeColor.trim())
      ? f.themeColor.trim().toLowerCase()
      : DEFAULT_THEME_COLOR,
    theme_color_source: isValidThemeColor(f.themeColor.trim())
      ? f.themeColorSource
      : ("default" as const),
    voice: {
      reserved: true as const,
      kind: f.voiceKind.trim() ? f.voiceKind.trim() : null,
      speed: f.voiceSpeed.trim() ? f.voiceSpeed.trim() : null,
    },
    avatar_memory: f.avatarMemory,
    switch_settings: {
      pass_conversation_summary: false as const,
      use_shared_info: f.useSharedInfo,
    },
    origin: existing?.origin ?? { type: "app" as const, chat_link: null },
    candidate_id: existing?.candidate_id ?? null,
    // CR-24: the 「キャラチャットに反映する」 preference and the last
    // reflection time are managed outside the form (the checkbox state
    // travels as the save call's sync_to_chara_chat argument, and the
    // synced-at stamp is written only by sync write-backs) — carried
    // through from the stored profile untouched.
    chara_chat_sync: existing?.chara_chat_sync ?? null,
    chara_chat_synced_at: existing?.chara_chat_synced_at ?? null,
  };
}

function fmtDate(iso: string | null): string {
  if (!iso) return "未設定";
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Card / tile image is always the avatar's own representative photo, derived
// automatically: the images entry flagged is_primary, else image_base.image_ref
// (when it is a renderable URL, or matches a stored image). There is no
// separate card-image setting anywhere in the UI.
function primaryImageSrc(p: Profile): string | null {
  const renderable = (img: Profile["images"][number]): string | null => {
    if (img.url) return img.url;
    if (img.source === "url") return img.file;
    return null;
  };
  const primary = p.images.find((i) => i.is_primary);
  if (primary) return renderable(primary);
  const ref = p.image_base.image_ref;
  if (ref) {
    if (/^https?:\/\//.test(ref)) return ref;
    const match = p.images.find((i) => i.blob_key === ref || i.file === ref);
    if (match) return renderable(match);
  }
  return null;
}

// CR-25: thumbnail version of the primary image (server-generated
// WebP, max 768px, pre-generated at profile creation / update / switch
// time and stored as a blob — see pregeneratePrimaryThumb in
// actions.ts). List cards, focus view, peeks, and tiles render THIS
// instead of the full-size original, so the list no longer downloads
// every original just to show small cards. Falls back to the original
// (primaryImageSrc) whenever no thumbnail exists, so a display never
// breaks; the detail screen's image grid keeps the originals.
function primaryThumbSrc(p: Profile): string | null {
  const primary = p.images.find((i) => i.is_primary);
  const ref = p.image_base.image_ref;
  const entry =
    primary ??
    (ref ? p.images.find((i) => i.blob_key === ref || i.file === ref) : undefined);
  if (entry?.thumb_url) return entry.thumb_url;
  return primaryImageSrc(p);
}

// CR-23: a YouTube playlist URL (youtube.com/playlist?list=…) can be a
// 参考動画URL — the chat side transcribes every video in the list.
// Mirrors the server-side detection in actions.ts.
function isYouTubePlaylistUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase();
    if (
      host !== "youtube.com" &&
      host !== "www.youtube.com" &&
      host !== "m.youtube.com" &&
      host !== "music.youtube.com"
    )
      return false;
    return u.pathname === "/playlist" && !!u.searchParams.get("list");
  } catch {
    return false;
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case "pending":
      return "未処理";
    case "processing":
      return "処理中";
    case "completed":
      return "完了";
    case "failed":
      return "失敗";
    default:
      return s;
  }
}

function fileToBase64(file: File): Promise<{ dataBase64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve({
        dataBase64: comma >= 0 ? result.slice(comma + 1) : result,
        mimeType: file.type,
      });
    };
    reader.onerror = () => reject(new Error("ファイルの読み取りに失敗しました。"));
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Small shared UI pieces
// ---------------------------------------------------------------------------

function StatusChip({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "var(--teal)"
      : status === "failed"
        ? "var(--accent)"
        : "var(--gold)";
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ border: `1.5px solid ${color}`, color }}
    >
      {statusLabel(status)}
    </span>
  );
}

// CR-15: requests that may be discarded from the request lists — the
// unprocessed ones (pending / processing) and the failed ones. Completed
// requests stay as history and get no delete button.
function canDeleteRequest(status: string): boolean {
  return status === "pending" || status === "processing" || status === "failed";
}

function genKindLabel(kind: GenRequest["kind"]): string {
  switch (kind) {
    case "image_generation":
      return "画像生成";
    case "link_summary":
      return "リンク要約";
    case "profile_apply":
      return "プロファイル反映（今すぐ反映）";
    case "flavor_examples":
      return "例文の自動作成";
    case "video_transcript":
      return "参考動画の文字起こし";
    case "chara_chat_sync":
      return "キャラチャットへ反映";
    default:
      return "試し会話";
  }
}

// CR-15: two-step delete for a queued request. The first tap only arms
// the confirmation (「消去」→「本当に消しますか？」＋「消去する」／「やめる」),
// so a request is never discarded by a single accidental tap. On success
// every request/profile query is invalidated, so the lists and the
// profiles' 反映待ち badges/counts update together.
function RequestDeleteButton({
  ariaSubject,
  deleteFn,
}: {
  ariaSubject: string;
  deleteFn: () => Promise<{ ok: boolean }>;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const delMut = useMutation({
    mutationFn: async () => await deleteFn(),
    onSuccess: () => {
      setConfirming(false);
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
      void queryClient.invalidateQueries({ queryKey: ["gen-open"] });
      void queryClient.invalidateQueries({ queryKey: ["gen-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["pending-switches"] });
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e) => {
      setConfirming(false);
      setError(e instanceof Error ? e.message : "消去に失敗しました。");
    },
  });
  if (!confirming) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={`${ariaSubject}を消去`}
          className="rounded-lg px-2.5 py-1 text-xs font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
          style={{
            border: "1.5px solid var(--accent)",
            color: "var(--accent)",
            background: "var(--surface)",
          }}
          disabled={delMut.isPending}
          onClick={() => {
            setError("");
            setConfirming(true);
          }}
        >
          消去
        </button>
        {error && (
          <span className="text-xs" style={{ color: "var(--accent)" }}>
            {error}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold" style={{ color: "var(--accent)" }}>
        本当に消しますか？
      </span>
      <button
        type="button"
        aria-label={`${ariaSubject}の消去を確定する`}
        className="rounded-lg px-2.5 py-1 text-xs font-bold text-white shadow-sm transition hover:opacity-90 active:scale-[0.98]"
        style={{ background: "var(--accent)" }}
        disabled={delMut.isPending}
        onClick={() => delMut.mutate()}
      >
        {delMut.isPending ? "消去中…" : "消去する"}
      </button>
      <button
        type="button"
        aria-label="消去をやめる"
        className="rounded-lg px-2.5 py-1 text-xs font-semibold"
        style={{ border: "1px solid var(--border)", background: "var(--surface)" }}
        disabled={delMut.isPending}
        onClick={() => setConfirming(false)}
      >
        やめる
      </button>
    </span>
  );
}

function preparationPendingLabels(p: Profile): string[] {
  const labels: string[] = [];
  if (p.preparation.image === "pending") labels.push("画像");
  if (p.preparation.link_summary === "pending") labels.push("参考リンク要約");
  if (p.preparation.greeting === "pending") labels.push("挨拶文");
  if (p.preparation.video === "pending") labels.push("参考動画");
  return labels;
}

function preparationFailedLabels(p: Profile): string[] {
  const labels: string[] = [];
  if (p.preparation.image === "failed") labels.push("画像");
  if (p.preparation.link_summary === "failed") labels.push("参考リンク要約");
  if (p.preparation.greeting === "failed") labels.push("挨拶文");
  if (p.preparation.video === "failed") labels.push("参考動画");
  return labels;
}

function PreparationBadge({ profile, showDetail = false }: { profile: Profile; showDetail?: boolean }) {
  const isReady = profile.preparation.status === "ready";
  const needsAttention = profile.preparation.status === "needs_attention";
  const pending = preparationPendingLabels(profile);
  const failed = preparationFailedLabels(profile);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span
        className="inline-block rounded-full px-2 py-0.5 text-xs font-bold text-white"
        style={{ background: isReady ? "var(--teal)" : needsAttention ? "var(--accent)" : "var(--gold)" }}
      >
        {isReady ? "✓ 利用可能" : needsAttention ? "要対応（失敗）" : "準備中"}
      </span>
      {needsAttention && failed.length > 0 && (
        <span className="text-xs" style={{ color: "var(--accent)" }}>
          失敗: {failed.join("・")}（詳細で理由と再試行を確認できます）
        </span>
      )}
      {!isReady && !needsAttention && showDetail && pending.length > 0 && (
        <span className="text-xs" style={{ color: "var(--dim)" }}>
          残り: {pending.join("・")}
        </span>
      )}
      {!isReady && !needsAttention && !showDetail && pending.length > 0 && (
        <span className="text-xs" style={{ color: "var(--dim)" }}>
          （{pending.join("・")}）
        </span>
      )}
    </span>
  );
}

// CR-03: open switch / profile_apply requests targeting this profile.
function PendingApplyBadge({ profile }: { profile: Profile }) {
  const parts: string[] = [];
  if (profile.pending_apply_count > 0) parts.push("プロファイル反映");
  if (profile.pending_switch_count > 0) parts.push("切替");
  if (parts.length === 0) return null;
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-xs font-bold text-white"
      style={{ background: "var(--gold)" }}
      aria-label={`反映待ち: ${parts.join("・")}`}
    >
      ⏳ 反映待ち（{parts.join("・")}）
    </span>
  );
}

// CR-21: shown while the profile's 「演じる姿・状況」 specification
// could not be honored by its source material (portrayal check state
// "failed"). The bias is inactive then — the profile is built and acted
// from all material as usual — and this badge is how the user learns
// the specification did not take effect. Warning color matches the
// other failure indicators (preparation 要対応 uses the same accent).
function PortrayalFailedBadge({ profile }: { profile: Profile }) {
  if (profile.background.portrayal_focus_status !== "failed") return null;
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-xs font-bold whitespace-nowrap text-white"
      style={{ background: "var(--accent)" }}
      aria-label="状況指定失敗（指定した姿・状況に当たる資料がありませんでした。バイアスは無効になっています）"
    >
      ⚠ 状況指定失敗
    </span>
  );
}

// CR-21: which source kinds the portrayal verdict was based on, for
// the detail screen ("判定に使った資料").
function portrayalCheckedLabels(profile: Profile): string[] {
  const checks = profile.background.portrayal_focus_checks;
  const labels: string[] = [];
  if (checks?.link_summary) labels.push("参考リンク");
  if (checks?.video_transcript) labels.push("参考動画");
  return labels;
}

function PreparationChecklist({ profile }: { profile: Profile }) {
  const rows: { label: string; state: string; reason: string | null }[] = [
    { label: "画像", state: profile.preparation.image, reason: profile.preparation_errors.image },
    { label: "参考リンク要約", state: profile.preparation.link_summary, reason: profile.preparation_errors.link_summary },
    { label: "挨拶文", state: profile.preparation.greeting, reason: profile.preparation_errors.greeting },
    { label: "参考動画", state: profile.preparation.video, reason: profile.preparation_errors.video },
  ];
  const labelFor = (s: string) => (s === "done" ? "完了" : s === "pending" ? "準備中" : s === "failed" ? "失敗" : "対象外");
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {rows.map((r) => (
        <li key={r.label} className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true">{r.state === "done" ? "✓" : r.state === "pending" ? "…" : r.state === "failed" ? "✕" : "−"}</span>
          <span>{r.label}: {labelFor(r.state)}</span>
          {r.state === "failed" && (
            <span style={{ color: "var(--accent)" }}>理由: {r.reason ?? "理由不明"}</span>
          )}
        </li>
      ))}
      <li className="pt-1 font-semibold">
        {profile.preparation.status === "ready"
          ? "全て完了して利用可能です"
          : profile.preparation.status === "needs_attention"
            ? "失敗した項目があります。下の「再試行」か代替手段で対応してください"
            : "準備が完了すると「利用可能」になります"}
      </li>
    </ul>
  );
}

function AvatarTile({
  profile,
  size,
}: {
  profile: Profile;
  size: number;
}) {
  const src = primaryThumbSrc(profile);
  const color = profile.theme_color || DEFAULT_THEME_COLOR;
  if (src) {
    return (
      <img
        src={src}
        alt={`${profile.name}の画像`}
        loading="lazy"
        decoding="async"
        className="shrink-0 rounded-xl object-cover"
        style={{ width: size, height: size, border: `2px solid ${color}` }}
      />
    );
  }
  return (
    <div
      aria-label={`${profile.name}の画像は未設定`}
      className="font-display flex shrink-0 flex-col items-center justify-center rounded-xl"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${color} 10%, var(--surface-alt))`,
        border: `2px solid ${color}`,
        color: "var(--accent)",
        fontSize: size * 0.36,
        lineHeight: 1.1,
      }}
    >
      <span>{profile.name.slice(0, 1) || "?"}</span>
      {size >= 64 && (
        <span
          className="mt-0.5 px-1 text-center"
          style={{ fontSize: 10, color: "var(--dim)", fontFamily: "inherit" }}
        >
          画像未設定
        </span>
      )}
    </div>
  );
}

// CR-10: list-card image — like the focus view, the WHOLE image fits
// inside a fixed-size frame (object-contain over a blurred copy of
// itself); nothing is cropped. The frame is tinted/bordered with the
// profile's theme color. The no-image placeholder occupies exactly the
// same frame so card sizes never depend on the image.
function CardAvatarImage({
  profile,
  size,
}: {
  profile: Profile;
  size: number;
}) {
  const src = primaryThumbSrc(profile);
  const color = profile.theme_color || DEFAULT_THEME_COLOR;
  if (src) {
    return (
      <div
        className="relative shrink-0 overflow-hidden rounded-xl"
        style={{
          width: size,
          height: size,
          background: `color-mix(in srgb, ${color} 12%, var(--surface-alt))`,
          border: `1.5px solid ${color}`,
        }}
      >
        <img
          src={src}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-lg"
        />
        <img
          src={src}
          alt={`${profile.name}の画像`}
          loading="lazy"
          decoding="async"
          className="relative h-full w-full object-contain"
        />
      </div>
    );
  }
  return (
    <div
      aria-label={`${profile.name}の画像は未設定`}
      className="font-display flex shrink-0 flex-col items-center justify-center rounded-xl"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${color} 10%, var(--surface-alt))`,
        border: `1.5px solid ${color}`,
        color: "var(--accent)",
        fontSize: size * 0.36,
        lineHeight: 1.1,
      }}
    >
      <span>{profile.name.slice(0, 1) || "?"}</span>
      <span
        className="mt-0.5 px-1 text-center"
        style={{ fontSize: 10, color: "var(--dim)", fontFamily: "inherit" }}
      >
        画像未設定
      </span>
    </div>
  );
}

// Copy helper with fallbacks. The artifact runs in a sandboxed iframe
// inside the Muse shell, where the async Clipboard API is commonly denied
// by the iframe permissions policy (NotAllowedError) even from a user
// gesture — a clipboard-only implementation silently copies nothing there.
// Order: (1) navigator.clipboard.writeText, (2) select the visible
// read-only textarea + document.execCommand("copy"), (3) leave the text
// selected and tell the user to copy it manually (long-press / Ctrl+C).
async function copyPhraseText(
  text: string,
  textEl: HTMLTextAreaElement | null,
): Promise<"copied" | "manual"> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return "copied";
    } catch {
      // fall through to the execCommand fallback
    }
  }
  if (textEl) {
    try {
      textEl.focus();
      textEl.select();
      textEl.setSelectionRange(0, text.length);
      if (document.execCommand("copy")) return "copied";
    } catch {
      // fall through to manual selection
    }
    // Keep the phrase selected so a manual copy is one gesture away.
    try {
      textEl.focus();
      textEl.select();
      textEl.setSelectionRange(0, text.length);
    } catch {
      // selection is best-effort only
    }
  }
  return "manual";
}

// CR-04: canned-phrase box. Pasting the phrase into chat is the formal
// trigger for switch / apply requests (no polling). Shown right after a
// request is created and, while the request stays open, on the detail
// screen and in the list's pending panels so it can be re-copied later.
function PhraseBox({
  phrase,
  kind = "switch",
}: {
  phrase: string;
  kind?: "switch" | "apply";
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // A new phrase (or a remount for another request) starts un-copied.
  useEffect(() => {
    setCopyState("idle");
  }, [phrase]);

  // "コピーしました" is transient feedback; return to the plain label.
  useEffect(() => {
    if (copyState !== "copied") return;
    const t = setTimeout(() => setCopyState("idle"), 3000);
    return () => clearTimeout(t);
  }, [copyState]);

  return (
    <div
      className="mt-2 rounded-lg p-3"
      style={{ background: "var(--surface-alt)", border: "1.5px solid var(--gold)" }}
    >
      <p className="text-sm font-semibold">
        {kind === "apply"
          ? "この定型文をチャットに貼って送信すると、すぐに反映されます"
          : "この定型文をチャットに貼って送信すると、すぐに切り替わります"}
      </p>
      <p className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>
        アプリからチャットへ直接送る機能はないため、この定型文をコピーしてチャットに貼るのが正式な依頼方法です。
      </p>
      <textarea
        ref={textRef}
        aria-label="定型文"
        readOnly
        value={phrase}
        rows={3}
        onFocus={(e) => e.currentTarget.select()}
        className="mt-1 w-full resize-none rounded-md p-2 text-sm"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          color: "var(--text)",
        }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="定型文をコピー"
          className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white"
          style={{ background: "var(--accent)" }}
          onClick={async () => {
            setCopyState(await copyPhraseText(phrase, textRef.current));
          }}
        >
          {copyState === "copied" ? "コピーしました" : "定型文をコピー"}
        </button>
        {copyState === "copied" && (
          <span className="text-xs font-semibold" style={{ color: "var(--teal)" }}>
            ✓ コピーできました。チャットに貼って送信してください
          </span>
        )}
      </div>
      {copyState === "manual" && (
        <p className="mt-2 text-xs font-semibold" style={{ color: "var(--accent)" }}>
          自動コピーがこの環境でブロックされました。上の定型文は選択済みですので、そのままコピー（スマホは長押し→コピー、PCは Ctrl+C / ⌘+C）してチャットに貼ってください。
        </p>
      )}
    </div>
  );
}

function SwitchStatusPanel({ requests }: { requests: SwitchRequest[] }) {
  if (requests.length === 0) return null;
  return (
    <section aria-label="切替リクエストの状態" className="mt-4">
      <h2 className="font-display text-base font-bold">切替リクエスト</h2>
      <ul className="mt-2 space-y-2">
        {requests.map((r) => (
          <li
            key={r.id}
            className="rounded-xl p-3"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{r.profile_name}</span>
              <StatusChip status={r.status} />
              <span className="text-xs" style={{ color: "var(--dim)" }}>
                {fmtDate(r.created_at)}
              </span>
              {canDeleteRequest(r.status) && (
                <span className="ml-auto">
                  <RequestDeleteButton
                    ariaSubject={`「${r.profile_name}」への切替リクエスト`}
                    deleteFn={async () =>
                      await api.deleteSwitchRequest({ request_id: r.id })
                    }
                  />
                </span>
              )}
            </div>
            {r.status === "failed" && r.reason && (
              <p className="mt-1 text-sm" style={{ color: "var(--accent)" }}>
                失敗理由: {r.reason}
              </p>
            )}
            {(r.status === "pending" || r.status === "processing") && (
              <PhraseBox phrase={r.phrase} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared profile form (create wizard + edit)
// ---------------------------------------------------------------------------

// CR-06: per-field origin badge for the structured speech fields.
// "auto" = generated from the background links/name by the chat side;
// "manual" = typed/corrected by the user (wins over auto generation).
function SpeechSourceBadge({
  source,
  hasValue,
}: {
  source: SpeechSource;
  hasValue: boolean;
}) {
  if (!hasValue) {
    return (
      <span
        className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold"
        style={{ border: "1px solid var(--border)", color: "var(--dim)" }}
      >
        未設定
      </span>
    );
  }
  const isManual = source !== "auto";
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-xs font-bold text-white"
      style={{ background: isManual ? "var(--gold)" : "var(--teal)" }}
    >
      {isManual ? "手動指定" : "自動生成"}
    </span>
  );
}

function TuningSlider({
  label,
  value,
  onChange,
  lowLabel,
  highLabel,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  lowLabel: string;
  highLabel: string;
}) {
  return (
    <div>
      <label className="flex items-center justify-between text-sm font-semibold">
        <span>{label}</span>
        <span aria-hidden="true">
          {"●".repeat(value)}
          {"○".repeat(5 - value)} {value}/5
        </span>
      </label>
      <input
        type="range"
        min={1}
        max={5}
        step={1}
        value={value}
        aria-label={`${label}（5段階）`}
        className="w-full"
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="flex justify-between text-xs" style={{ color: "var(--dim)" }}>
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </div>
  );
}

// CR-12: badge shown on a trait whose examples will be auto-generated:
// 「例文を自動作成」 is on but no example line is stored yet. Saving the
// profile queues a flavor_examples request; the badge clears once the
// chat side writes examples back (or the user types their own).
export function AutoExamplesPendingBadge() {
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-xs font-bold text-white"
      style={{ background: "var(--gold)" }}
    >
      自動作成待ち
    </span>
  );
}

export function traitNeedsAutoExamples(t: FlavorTrait): boolean {
  return (
    (t.auto_examples ?? false) &&
    !t.examples.some((e) => e.trim())
  );
}

// CR-08: flavor trait list editor. Every edit the user makes here flips
// the trait's source to "manual" (manual traits are never overwritten by
// generation write-backs). Auto traits keep their 自動生成 badge until
// touched.
// CR-14: each trait also has a per-trait frequency control — a slider
// 0-5 when individually set, or "全体に従う" (frequency null).
function FlavorTraitsEditor({
  traits,
  onChange,
  globalLevel = 3,
}: {
  traits: FlavorTrait[];
  onChange: (t: FlavorTrait[]) => void;
  globalLevel?: number;
}) {
  const inputCls = "w-full rounded-lg px-3 py-2 text-sm";
  const inputStyle = { background: "var(--surface)", border: "1px solid var(--border)" };
  const update = (idx: number, patch: Partial<FlavorTrait>) => {
    onChange(
      traits.map((t, i) =>
        i === idx ? { ...t, ...patch, source: "manual" as const } : t,
      ),
    );
  };
  return (
    <div className="space-y-3">
      {traits.length === 0 && (
        <p className="text-sm" style={{ color: "var(--dim)" }}>
          フレーバー項目はまだありません。背景リンクの要約や挨拶文の生成で自動で入るほか、下のボタンから手動で追加できます。
        </p>
      )}
      {traits.map((t, idx) => {
        const effFreq = effectiveFlavorFrequency(t, globalLevel);
        const freqDiffers = flavorFrequencyIsCustom(t, globalLevel);
        return (
        <div
          key={t.id || idx}
          className="rounded-lg p-3 space-y-2"
          style={{
            border: freqDiffers ? "2px solid var(--gold)" : "1px solid var(--border)",
            background: freqDiffers ? "color-mix(in srgb, var(--gold) 6%, var(--surface))" : "var(--surface)",
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-h-9 items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={t.enabled}
                aria-label={`フレーバー項目「${t.label || "名称未設定"}」を有効にする`}
                onChange={(e) => update(idx, { enabled: e.target.checked })}
              />
              有効
            </label>
            <SpeechSourceBadge source={t.source} hasValue={!!t.label.trim() || t.examples.length > 0} />
            <FlavorEffectiveBadge trait={t} globalLevel={globalLevel} />
            {traitNeedsAutoExamples(t) && <AutoExamplesPendingBadge />}
            <span className="flex-1" />
            <button
              type="button"
              aria-label={`フレーバー項目「${t.label || "名称未設定"}」を削除`}
              className="rounded-lg px-2.5 py-1 text-xs font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
              style={{ border: "1.5px solid var(--accent)", color: "var(--accent)", background: "var(--surface)" }}
              onClick={() => onChange(traits.filter((_, i) => i !== idx))}
            >
              削除
            </button>
          </div>
          <div>
            <label htmlFor={`ft-label-${idx}`} className="text-sm font-semibold">項目名（ラベル）</label>
            <input
              id={`ft-label-${idx}`}
              className={inputCls}
              style={inputStyle}
              value={t.label}
              maxLength={200}
              placeholder="例: 主さまを褒める／天才自慢と高笑い"
              onChange={(e) => update(idx, { label: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor={`ft-examples-${idx}`} className="text-sm font-semibold">例文（1行に1つ、複数可）</label>
            <textarea
              id={`ft-examples-${idx}`}
              className={inputCls}
              style={inputStyle}
              rows={2}
              value={t.examples.join("\n")}
              placeholder={"例: 頑張りましたね、あるじ様"}
              onChange={(e) => update(idx, { examples: e.target.value.split("\n") })}
            />
          </div>
          <div>
            <label className="flex min-h-9 items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={t.auto_examples ?? false}
                aria-label={`フレーバー項目「${t.label || "名称未設定"}」の例文を自動作成する`}
                onChange={(e) => update(idx, { auto_examples: e.target.checked })}
              />
              例文を自動作成
            </label>
            <p className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>
              オンで例文が未入力の項目は、保存時にチャット側へ例文の自動作成を依頼します（自動作成待ち）。あなたが例文を手で入れた項目は、自動作成で上書きされません。
            </p>
          </div>
          <div className="rounded-lg p-2" style={{ background: "var(--surface-alt)", border: "1px solid var(--border)" }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">この項目の頻度</span>
              <span className="text-xs font-semibold" style={{ color: freqDiffers ? "var(--gold)" : "var(--dim)" }}>
                実効 {effFreq}/5 — {FLAVOR_LEVEL_DESCRIPTIONS[effFreq] ?? ""}
                {t.frequency == null ? `（全体 ${globalLevel} に従う）` : freqDiffers ? `（全体 ${globalLevel} と異なる個別設定）` : "（個別設定）"}
              </span>
            </div>
            {t.frequency == null ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-sm" style={{ color: "var(--dim)" }}>全体に従う（未設定）— 全体のバーを変えると、この項目も一緒に変わります。</span>
                <button
                  type="button"
                  aria-label={`フレーバー項目「${t.label || "名称未設定"}」の頻度を個別に設定する`}
                  className="rounded-lg px-3 py-1.5 text-xs font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
                  style={{ border: "1.5px solid var(--border)", background: "var(--surface)" }}
                  onClick={() => update(idx, { frequency: globalLevel })}
                >
                  個別に設定する
                </button>
              </div>
            ) : (
              <div className="mt-2">
                <label className="flex items-center justify-between text-sm font-semibold">
                  <span>個別の頻度</span>
                  <span aria-hidden="true">{"●".repeat(t.frequency)}{"○".repeat(5 - t.frequency)} {t.frequency}/5</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={1}
                  value={t.frequency}
                  aria-label={`フレーバー項目「${t.label || "名称未設定"}」の頻度（0から5）`}
                  className="w-full"
                  onChange={(e) => update(idx, { frequency: Number(e.target.value) })}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs" style={{ color: "var(--dim)" }}>0: この項目は出さない ／ 3: 節目に自然に ／ 5: 頻繁に</span>
                  <button
                    type="button"
                    aria-label={`フレーバー項目「${t.label || "名称未設定"}」の頻度を全体に従うに戻す`}
                    className="rounded-lg px-3 py-1.5 text-xs font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
                    style={{ border: "1.5px solid var(--teal)", color: "var(--teal)", background: "var(--surface)" }}
                    onClick={() => update(idx, { frequency: null })}
                  >
                    全体に従う（未設定）に戻す
                  </button>
                </div>
              </div>
            )}
          </div>
          <div>
            <span className="text-sm font-semibold">出る場面</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {FLAVOR_SCENE_PRESETS.map((scene) => {
                const active = t.scenes.includes(scene);
                return (
                  <button
                    key={scene}
                    type="button"
                    aria-label={`出る場面「${scene}」を${active ? "外す" : "加える"}`}
                    aria-pressed={active}
                    className="rounded-full px-2.5 py-1 text-xs font-semibold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
                    style={{
                      border: "1.5px solid var(--border)",
                      background: active ? "var(--accent)" : "var(--surface)",
                      color: active ? "var(--accent-ink)" : "var(--text)",
                    }}
                    onClick={() =>
                      update(idx, {
                        scenes: active
                          ? t.scenes.filter((s) => s !== scene)
                          : [...t.scenes, scene],
                      })
                    }
                  >
                    {scene}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        );
      })}
      <button
        type="button"
        aria-label="フレーバー項目を追加"
        className="rounded-lg px-3 py-2 text-sm font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
        style={{ border: "1.5px solid var(--border)", background: "var(--surface-alt)" }}
        onClick={() =>
          onChange([
            ...traits,
            {
              id: newFlavorTraitId(),
              label: "",
              examples: [],
              scenes: [],
              enabled: true,
              source: "manual",
              // CR-12: hand-added traits default to auto_examples off;
              // the user opts in per trait with the checkbox.
              auto_examples: false,
              // CR-14: hand-added traits follow the global level by default.
              frequency: null,
            },
          ])
        }
      >
        ＋ フレーバー項目を追加
      </button>
    </div>
  );
}

function ElementsEditor({
  elements,
  onChange,
}: {
  elements: Elements;
  onChange: (e: Elements) => void;
}) {
  return (
    <div className="space-y-4">
      {ELEMENT_DEFS.map(({ key, presets }) => {
        const value = elements[key] ?? "";
        const isBackground = key === "背景";
        return (
          <div key={key}>
            <label
              htmlFor={`el-${key}`}
              className="text-sm font-semibold"
            >
              {key}
              {isBackground && (
                <span className="ml-2 text-xs font-normal" style={{ color: "var(--dim)" }}>
                  生成側の仕様で当面は白固定です
                </span>
              )}
            </label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-label={`${key}を「${p}」にする`}
                  aria-pressed={value === p}
                  className="rounded-full px-2.5 py-1 text-xs"
                  style={{
                    border: "1px solid var(--border)",
                    background: value === p ? "var(--accent)" : "var(--surface)",
                    color: value === p ? "var(--accent-ink)" : "var(--text)",
                  }}
                  onClick={() => onChange({ ...elements, [key]: p })}
                >
                  {p}
                </button>
              ))}
              {value && !presets.includes(value) && (
                <span
                  className="rounded-full px-2.5 py-1 text-xs text-white"
                  style={{ background: "var(--accent)" }}
                >
                  {value}
                </span>
              )}
            </div>
            <input
              id={`el-${key}`}
              aria-label={`${key}（自由入力）`}
              className="mt-1.5 w-full rounded-lg px-3 py-2 text-sm"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
              value={value}
              disabled={isBackground}
              placeholder="チップで選ぶか、自由に入力"
              onChange={(e) => onChange({ ...elements, [key]: e.target.value })}
            />
          </div>
        );
      })}
    </div>
  );
}

function UploadIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M12 16V4" />
      <path d="m6 10 6-6 6 6" />
      <path d="M4 20h16" />
    </svg>
  );
}

export const uploadButtonClass =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-bold shadow-sm transition hover:opacity-90 hover:shadow active:scale-[0.98] active:opacity-80 focus-visible:outline-2";

function ProfileFormFields({
  form,
  setForm,
  showOptional,
  onToggleOptional,
  elementsCollapsed = false,
  hasImage = false,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  showOptional?: boolean;
  onToggleOptional?: () => void;
  // CR-05: when an image (upload/URL) is the base, elements are a closed
  // option by default because the image takes priority. When the base is
  // element-spec (no image), elements stay normally visible.
  elementsCollapsed?: boolean;
  hasImage?: boolean;
}) {
  const [internalShowOptional, setInternalShowOptional] = useState(false);
  const [bgTextOpen, setBgTextOpen] = useState(false);
  const [elementsOpen, setElementsOpen] = useState(false);
  const effectiveShowOptional = showOptional !== undefined ? showOptional : internalShowOptional;
  const toggleOptional = onToggleOptional ?? (() => setInternalShowOptional(!internalShowOptional));
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const inputCls = "w-full rounded-lg px-3 py-2 text-sm";
  const inputStyle = { background: "var(--surface)", border: "1px solid var(--border)" };
  // CR-05 conditional display (display-only; form state is never cleared).
  const hasBgLinks = form.bgLinks.some((l) => l.trim().length > 0);
  const bgTextFilled = form.bgText.trim().length > 0;
  const filledElementCount = ELEMENT_DEFS.filter(
    ({ key }) => key !== "背景" && (form.elements[key] ?? "").trim().length > 0,
  ).length;
  const elementsFilled = filledElementCount > 0;
  const showElementsNormal = !elementsCollapsed;
  return (
    <div className="space-y-6">
      {/* 必須セクション */}
      <div className="rounded-xl p-3" style={{ border: "2px solid var(--teal)", background: "var(--surface)" }}>
        <p className="text-xs font-bold" style={{ color: "var(--teal)" }}>必須項目（これだけで保存できます）</p>
        <fieldset className="mt-3 space-y-3">
          <legend className="font-display text-base font-bold">基本</legend>
          <div>
            <label htmlFor="f-name" className="text-sm font-semibold">名前（必須）</label>
            <input id="f-name" className={inputCls} style={inputStyle} value={form.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div>
            <label htmlFor="f-summary" className="text-sm font-semibold">一覧に出す1行要約</label>
            <input id="f-summary" className={inputCls} style={inputStyle} value={form.summary} maxLength={300} placeholder="例: 世紀の天才科学者。IQ300。" onChange={(e) => set({ summary: e.target.value })} />
          </div>
        </fieldset>
        <fieldset className="mt-5 space-y-3">
          <legend className="font-display text-base font-bold">バックグラウンド（必須セクション）</legend>
          <p className="text-xs" style={{ color: "var(--dim)" }}>キャラクター背景は手入力か、参考URLを渡すのが基本です。参考URLは下に貼るだけで要約を自動で依頼します。</p>
          {!hasBgLinks ? (
            <div>
              <label htmlFor="f-bg" className="text-sm font-semibold">人物設定（手入力）</label>
              <textarea id="f-bg" className={inputCls} style={inputStyle} rows={5} value={form.bgText} onChange={(e) => set({ bgText: e.target.value })} />
            </div>
          ) : (
            <div className="rounded-lg p-3" style={{ border: "1px dashed var(--border)", background: "var(--surface-alt)" }}>
              <p className="text-xs font-semibold" style={{ color: "var(--teal)" }}>リンク先の要約が優先されます</p>
              <p className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>参考リンクがあるため、背景の手書きテキストは任意（オプション）です。開けば従来通り入力できます。</p>
              <button type="button" aria-label={bgTextOpen ? "背景テキストを隠す" : "背景テキストを表示"} aria-expanded={bgTextOpen} className="mt-2 inline-flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]" style={{ border: "1.5px solid var(--border)", background: "var(--surface)", color: "var(--text)" }} onClick={() => setBgTextOpen(!bgTextOpen)}>
                {bgTextOpen ? "背景テキスト（手入力・任意）を隠す ▲" : "背景テキスト（手入力・任意）を表示 ▼"}
                {bgTextFilled && <span className="rounded-full px-2 py-0.5 text-xs font-bold text-white" style={{ background: "var(--teal)" }}>入力済み</span>}
              </button>
              {bgTextOpen && (
                <div className="mt-2">
                  <label htmlFor="f-bg" className="text-sm font-semibold">人物設定（手入力・任意）</label>
                  <textarea id="f-bg" className={inputCls} style={inputStyle} rows={5} value={form.bgText} onChange={(e) => set({ bgText: e.target.value })} />
                </div>
              )}
            </div>
          )}
          <div>
            <span className="text-sm font-semibold">参考リンク（複数可）★最短経路の中心</span>
            {form.bgLinks.length === 0 && (
              <div className="mt-2 flex gap-2">
                <input aria-label="参考リンク 1" className={inputCls} style={inputStyle} value="" placeholder="https://…（キャラクター背景の参考URL）" onChange={(e) => set({ bgLinks: [e.target.value] })} />
              </div>
            )}
            {form.bgLinks.map((link, i) => (
              <div key={i} className="mt-2 flex gap-2">
                <input aria-label={`参考リンク ${i + 1}`} className={inputCls} style={inputStyle} value={link} placeholder="https://…" onChange={(e) => { const next = [...form.bgLinks]; next[i] = e.target.value; set({ bgLinks: next }); }} />
                <button type="button" aria-label={`参考リンク ${i + 1} を削除`} className="shrink-0 rounded-lg px-3 text-sm font-semibold shadow-sm transition hover:opacity-90 active:scale-[0.98]" style={{ border: "1.5px solid var(--border)", background: "var(--surface-alt)" }} onClick={() => set({ bgLinks: form.bgLinks.filter((_, j) => j !== i) })}>削除</button>
              </div>
            ))}
            <button type="button" aria-label="参考リンクを追加" className="mt-2 rounded-lg px-3 py-1.5 text-sm font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]" style={{ border: "1.5px solid var(--border)", background: "var(--surface-alt)" }} onClick={() => set({ bgLinks: [...form.bgLinks, ""] })}>＋ リンクを追加</button>
            <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>読み取りは二段階が標準です（全プロファイル共通）：まず通常のテキスト取得で読み、読めなかったURLは実ブラウザで開いて再取得します。両方で読めなかった場合だけ「読み取り不可」として記録されます。</p>
          </div>
          <div>
            <span className="text-sm font-semibold">参考動画URL（複数可）</span>
            <p className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>文字起こし（字幕）を取得できる動画サイトのURLを指定してください（推奨：YouTube）。YouTubeの再生リストURLも指定できます。その場合は、リスト内の各動画の文字起こしを取得します。動画の台詞は口調の参考にします。参考リンクとは別扱いです（動画を通常のWebページとして読むことはしません）。保存すると、まだ処理していない動画について文字起こしの取得を自動で依頼します。</p>
            {form.bgVideoUrls.length === 0 && (
              <div className="mt-2 flex gap-2">
                <input aria-label="参考動画URL 1" className={inputCls} style={inputStyle} value="" placeholder="https://…（YouTubeの動画URL／再生リストURL）" onChange={(e) => set({ bgVideoUrls: [e.target.value] })} />
              </div>
            )}
            {form.bgVideoUrls.map((link, i) => (
              <div key={i} className="mt-2">
                <div className="flex gap-2">
                  <input aria-label={`参考動画URL ${i + 1}`} className={inputCls} style={inputStyle} value={link} placeholder="https://…" onChange={(e) => { const next = [...form.bgVideoUrls]; next[i] = e.target.value; set({ bgVideoUrls: next }); }} />
                  <button type="button" aria-label={`参考動画URL ${i + 1} を削除`} className="shrink-0 rounded-lg px-3 text-sm font-semibold shadow-sm transition hover:opacity-90 active:scale-[0.98]" style={{ border: "1.5px solid var(--border)", background: "var(--surface-alt)" }} onClick={() => set({ bgVideoUrls: form.bgVideoUrls.filter((_, j) => j !== i) })}>削除</button>
                </div>
                {isYouTubePlaylistUrl(link) && (
                  <p className="mt-1 text-xs font-semibold" style={{ color: "var(--teal)" }}>YouTubeの再生リストとして認識しました（リスト内の各動画の文字起こしを取得します）</p>
                )}
              </div>
            ))}
            <button type="button" aria-label="参考動画URLを追加" className="mt-2 rounded-lg px-3 py-1.5 text-sm font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]" style={{ border: "1.5px solid var(--border)", background: "var(--surface-alt)" }} onClick={() => set({ bgVideoUrls: [...form.bgVideoUrls, ""] })}>＋ 動画URLを追加</button>
          </div>
          <div>
            <label htmlFor="f-linksum" className="text-sm font-semibold">参考リンクの要約（自動生成されたものがここに入ります）</label>
            <textarea id="f-linksum" className={inputCls} style={inputStyle} rows={3} value={form.linkSummary} placeholder="未設定（リンク先を読めなかった場合は「読み取り不可」と記録されます）" onChange={(e) => set({ linkSummary: e.target.value })} />
          </div>
          <div>
            <label htmlFor="f-user-relationship" className="text-sm font-semibold">私の扱い（任意）</label>
            <p className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>このキャラクターから見て、あなたがどういう存在かの指定です。明記した場合は、挨拶文の生成や実際の会話での接し方（主従・対等などの距離感や態度）がそれに倣います。未指定の場合は、背景や呼び方から自然に推定される扱いのままになります。</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {USER_RELATIONSHIP_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-label={`私の扱いを「${preset}」にする`}
                  aria-pressed={form.userRelationship.trim() === preset}
                  className="rounded-full px-2.5 py-1 text-xs font-semibold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
                  style={{
                    border: "1.5px solid var(--border)",
                    background: form.userRelationship.trim() === preset ? "var(--accent)" : "var(--surface)",
                    color: form.userRelationship.trim() === preset ? "var(--accent-ink)" : "var(--text)",
                  }}
                  onClick={() => set({ userRelationship: preset })}
                >
                  {preset}
                </button>
              ))}
            </div>
            <textarea id="f-user-relationship" className={`${inputCls} mt-1.5`} style={inputStyle} rows={3} value={form.userRelationship} maxLength={2000} placeholder="例: 主人に当たる存在で、丁重にお仕えする関係。／ 関わりが深い者の友人で、体を借りている設定のため、友人として対等に接する。など、複雑な設定は文章で書けます" onChange={(e) => set({ userRelationship: e.target.value })} />
          </div>
          <div>
            <label htmlFor="f-portrayal-focus" className="text-sm font-semibold">演じる姿・状況（任意）</label>
            <p className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>指定すると、その姿・状況に当たる資料を中心にプロファイルを作ります。空欄の場合は通常どおり全体から作ります。切り替えや試し会話でも、その姿・状況で応答する前提として渡されます。資料に該当する部分が無い場合は、指定を無視して全体から通常どおり作り、プロファイルに「状況指定失敗」と理由が表示されます（資料を追加・変更して当たる資料が見つかれば、指定は自動で再び有効になります）。</p>
            <textarea id="f-portrayal-focus" className={`${inputCls} mt-1.5`} style={inputStyle} rows={2} value={form.portrayalFocus} maxLength={2000} placeholder="例: 中学生の時のみ／闇落ちした状態／もしも〜だったら（if設定）など、寄せたい姿・状況を書けます" onChange={(e) => set({ portrayalFocus: e.target.value })} />
          </div>
        </fieldset>
        {showElementsNormal ? (
          <fieldset className="mt-5 space-y-3">
            <legend className="font-display text-base font-bold">見た目の要素指定</legend>
            <p className="text-xs" style={{ color: "var(--dim)" }}>画像がない場合は、この要素指定がアバターの見た目の基準になります。</p>
            <ElementsEditor elements={form.elements} onChange={(elements) => set({ elements })} />
          </fieldset>
        ) : (
          <div className="mt-5 rounded-lg p-3" style={{ border: "1px dashed var(--border)", background: "var(--surface-alt)" }}>
            <p className="text-xs font-semibold" style={{ color: "var(--teal)" }}>{hasImage ? "画像が優先されます。要素は補助情報です" : "要素指定は任意（オプション）です"}</p>
            <p className="mt-0.5 text-xs" style={{ color: "var(--dim)" }}>{hasImage ? "画像（アップロード／URL）で見た目を渡しているため、要素指定は既定で閉じています。入力しても画像側が優先されますが、補助情報として保存されます。" : "要素指定は既定で閉じたオプションです。開けば従来通り入力できます。"}</p>
            <button type="button" aria-label={elementsOpen ? "要素指定を隠す" : "要素指定を表示"} aria-expanded={elementsOpen} className="mt-2 inline-flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]" style={{ border: "1.5px solid var(--border)", background: "var(--surface)", color: "var(--text)" }} onClick={() => setElementsOpen(!elementsOpen)}>
              {elementsOpen ? "要素指定（補助情報・任意）を隠す ▲" : "要素指定（補助情報・任意）を表示 ▼"}
              {elementsFilled && <span className="rounded-full px-2 py-0.5 text-xs font-bold text-white" style={{ background: "var(--teal)" }}>入力済み（{filledElementCount}項目）</span>}
            </button>
            {elementsOpen && (
              <fieldset className="mt-3 space-y-3">
                <legend className="font-display text-base font-bold">見た目の要素指定（補助情報）</legend>
                <ElementsEditor elements={form.elements} onChange={(elements) => set({ elements })} />
              </fieldset>
            )}
          </div>
        )}
      </div>

      {/* CR-08: フレーバー設定（キャラクターらしさ） */}
      <div className="rounded-xl p-3" style={{ border: "2px solid var(--gold)", background: "var(--surface)" }}>
        <fieldset className="space-y-3">
          <legend className="font-display text-base font-bold">フレーバー設定（キャラクターらしさ）</legend>
          <p className="text-xs" style={{ color: "var(--dim)" }}>
            そのキャラクターらしい振る舞い（褒める・自慢する・高笑いなど）を、どれくらい・どんな形で応答に出すかの設定です。項目は背景リンクの要約や挨拶文の生成で自動で入ります（自動生成）。あなたが追加・編集した項目は「手動指定」になり、再生成でも上書きされません。切り替え・即時反映の際は、この量と有効な項目がチャット側へ渡ります。各項目の「例文を自動作成」をオンにすると、例文が未入力の間は保存のたびにチャット側が例文を考えて書き足します（自動作成待ちと表示されます）。頻度は全体のバーが一括（既定）で、各項目ごとに個別の頻度も設定できます。項目の頻度が未設定の場合は全体に従い、設定した項目だけその値が優先されます。
          </p>
          <div>
            <label className="flex items-center justify-between text-sm font-semibold">
              <span>フレーバーの量（一括・既定）</span>
              <span aria-hidden="true">
                {"●".repeat(form.flavorLevel)}
                {"○".repeat(5 - form.flavorLevel)} {form.flavorLevel}/5
              </span>
            </label>
            <input
              type="range"
              min={0}
              max={5}
              step={1}
              value={form.flavorLevel}
              aria-label="フレーバーの量（一括・既定）（0から5）"
              className="w-full"
              onChange={(e) => set({ flavorLevel: Number(e.target.value) })}
            />
            <p className="text-sm font-semibold" style={{ color: "var(--gold)" }}>
              現在（一括・既定）: {form.flavorLevel} — {FLAVOR_LEVEL_DESCRIPTIONS[form.flavorLevel] ?? ""}
            </p>
            <div className="flex justify-between text-xs" style={{ color: "var(--dim)" }}>
              <span>0: 出さない</span>
              <span>3: 節目に自然に</span>
              <span>5: 頻繁に</span>
            </div>
            <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>
              このバーは「全体に従う」にしている項目の頻度です。項目ごとに個別設定した場合は、その項目だけ個別の値が優先されます。
            </p>
            {form.flavorTraits.filter((t) => t.label.trim()).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label="全項目へ一括で現在の全体の値を写す"
                  className="rounded-lg px-3 py-1.5 text-xs font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
                  style={{ border: "1.5px solid var(--border)", background: "var(--surface-alt)" }}
                  onClick={() =>
                    set({
                      flavorTraits: form.flavorTraits.map((t) => ({
                        ...t,
                        frequency: form.flavorLevel,
                        source: "manual" as const,
                      })),
                    })
                  }
                >
                  全項目へ一括で値を写す（{form.flavorLevel}/5 を全項目の個別頻度にする）
                </button>
                <button
                  type="button"
                  aria-label="全項目を全体に従うに戻す"
                  className="rounded-lg px-3 py-1.5 text-xs font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
                  style={{ border: "1.5px solid var(--teal)", color: "var(--teal)", background: "var(--surface)" }}
                  onClick={() =>
                    set({
                      flavorTraits: form.flavorTraits.map((t) => ({
                        ...t,
                        frequency: null,
                      })),
                    })
                  }
                >
                  全項目を全体に従うに戻す
                </button>
              </div>
            )}
          </div>
          <FlavorTraitsEditor
            traits={form.flavorTraits}
            onChange={(flavorTraits) => set({ flavorTraits })}
            globalLevel={form.flavorLevel}
          />
        </fieldset>
      </div>

      {/* CR-10: テーマカラー */}
      <div
        className="rounded-xl p-3"
        style={{
          border: `2px solid ${isValidThemeColor(form.themeColor) ? form.themeColor : DEFAULT_THEME_COLOR}`,
          background: "var(--surface)",
        }}
      >
        <fieldset className="space-y-3">
          <legend className="font-display text-base font-bold">テーマカラー</legend>
          <p className="text-xs" style={{ color: "var(--dim)" }}>
            一覧・フォーカスのカードを彩る色です。プロファイル作成時は、代表画像があればその主要色から、無ければ見た目の要素（メインカラー・服装など）から自動で取得します。取得できない場合は既定色になります。ここで色を変えると「手動指定」になり、画像を差し替えても自動で上書きされません。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-hidden="true"
              className="h-11 w-11 shrink-0 rounded-lg shadow-sm"
              style={{
                background: isValidThemeColor(form.themeColor)
                  ? form.themeColor
                  : DEFAULT_THEME_COLOR,
                border: "1.5px solid var(--border)",
              }}
            />
            <div>
              <label htmlFor="f-theme-color" className="text-sm font-semibold">
                テーマカラーを選ぶ
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  id="f-theme-color"
                  type="color"
                  aria-label="テーマカラーを選ぶ"
                  className="h-10 w-14 shrink-0 cursor-pointer rounded-lg"
                  style={{ border: "1.5px solid var(--border)", background: "var(--surface)" }}
                  value={
                    isValidThemeColor(form.themeColor)
                      ? form.themeColor.toLowerCase()
                      : DEFAULT_THEME_COLOR
                  }
                  onChange={(e) =>
                    set({ themeColor: e.target.value, themeColorSource: "manual" })
                  }
                />
                <input
                  aria-label="テーマカラー（16進数）"
                  className="w-24 rounded-lg px-2 py-1.5 text-sm"
                  style={inputStyle}
                  value={form.themeColor}
                  maxLength={7}
                  placeholder="#64748b"
                  onChange={(e) => {
                    const v = e.target.value;
                    set({
                      themeColor: v,
                      themeColorSource: isValidThemeColor(v.trim())
                        ? "manual"
                        : form.themeColorSource,
                    });
                  }}
                />
                <ThemeSourceBadge source={form.themeColorSource} />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label="テーマカラーを自動取得に戻す"
              className="rounded-lg px-3 py-1.5 text-sm font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
              style={{ border: "1.5px solid var(--border)", background: "var(--surface-alt)" }}
              onClick={() => {
                const derived = deriveThemeColorFromElements(form.elements);
                set({
                  themeColor: derived ?? DEFAULT_THEME_COLOR,
                  themeColorSource: derived ? "auto" : "default",
                });
              }}
            >
              自動取得に戻す（要素から）
            </button>
            <span className="text-xs" style={{ color: "var(--dim)" }}>
              画像がある場合は、画像の差し替え・代表画像の変更時にその主要色で自動更新されます（手動指定のときは更新されません）。
            </span>
          </div>
        </fieldset>
      </div>

      {/* オプション切替 */}
      <div>
        <button type="button" aria-label={effectiveShowOptional ? "オプションを隠す" : "オプションを表示"} aria-expanded={effectiveShowOptional} className="w-full rounded-lg px-4 py-2.5 text-sm font-bold" style={{ border: "1px solid var(--border)", background: "var(--surface-alt)" }} onClick={toggleOptional}>
          {effectiveShowOptional ? "オプションを隠す ▲" : "オプションを表示 ▼（呼び方・話し方・微調整・音声など）"}
        </button>
        <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>オプションは既定では非表示です。必須だけでも保存できます。</p>
      </div>

      {effectiveShowOptional && (
        <div className="space-y-6 rounded-xl p-3" style={{ border: "1px solid var(--border)", background: "var(--surface)" }} aria-label="オプション設定">
          <fieldset className="space-y-3">
            <legend className="font-display text-base font-bold">オプション: お気に入り</legend>
            <label className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" className="h-5 w-5" checked={form.favorite} onChange={(e) => set({ favorite: e.target.checked })} />
              お気に入り（ピン留め）にする
            </label>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="font-display text-base font-bold">オプション: 口調の設定・補正と微調整</legend>
            <p className="rounded-lg p-3 text-sm" style={{ background: "var(--surface-alt)" }}>
              未記入の欄は自動生成が使われます。記入した欄は自動生成より優先されます。自動生成された値も各欄に表示されますので、情報不足や誤りがあれば書き換えて補正してください（書き換えた欄は「手動指定」になり、再生成でも上書きされません）。
            </p>
            {(
              [
                { id: "f-first-person", label: "一人称", field: "speechFirstPerson" as const, sourceKey: "first_person" as const, value: form.speechFirstPerson, placeholder: "例: わたくし / ワシ / 僕", maxLength: 500 },
                { id: "f-second-person", label: "二人称", field: "speechSecondPerson" as const, sourceKey: "second_person" as const, value: form.speechSecondPerson, placeholder: "例: あなた / お主 / 君", maxLength: 500 },
                { id: "f-call", label: "私の呼び方", field: "callUserAs" as const, sourceKey: "call_user_as" as const, value: form.callUserAs, placeholder: "空なら既定の呼び方", maxLength: 500 },
                { id: "f-catchphrase", label: "口癖", field: "speechCatchphrase" as const, sourceKey: "catchphrase" as const, value: form.speechCatchphrase, placeholder: "例: ホーッホッホッホッホ（高笑い）", maxLength: 1000 },
              ]
            ).map((row) => (
              <div key={row.id}>
                <div className="flex items-center gap-2">
                  <label htmlFor={row.id} className="text-sm font-semibold">{row.label}</label>
                  <SpeechSourceBadge source={form.speechSources[row.sourceKey] ?? (row.value.trim() ? "manual" : null)} hasValue={!!row.value.trim()} />
                </div>
                <input
                  id={row.id}
                  className={inputCls}
                  style={inputStyle}
                  value={row.value}
                  maxLength={row.maxLength}
                  placeholder={row.placeholder}
                  onChange={(e) =>
                    set({
                      [row.field]: e.target.value,
                      speechSources: {
                        ...form.speechSources,
                        [row.sourceKey]: e.target.value.trim() ? "manual" : null,
                      },
                    } as Partial<FormState>)
                  }
                />
              </div>
            ))}
            <div>
              <div className="flex items-center gap-2">
                <label htmlFor="f-speech-memo" className="text-sm font-semibold">語尾・口調メモ（自由記述）</label>
                <SpeechSourceBadge source={form.speechSources.memo ?? (form.speechMemo.trim() ? "manual" : null)} hasValue={!!form.speechMemo.trim()} />
              </div>
              <textarea id="f-speech-memo" className={inputCls} style={inputStyle} rows={2} value={form.speechMemo} maxLength={2000} placeholder="例: 語尾は〜じゃ／〜わい。丁寧だが尊大。短文で畳みかける" onChange={(e) => set({ speechMemo: e.target.value, speechSources: { ...form.speechSources, memo: e.target.value.trim() ? "manual" : null } })} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label htmlFor="f-speech" className="text-sm font-semibold">話し方スタイル文（任意）</label>
                <SpeechSourceBadge source={form.speechSources.style ?? (form.speechStyle.trim() ? "manual" : null)} hasValue={!!form.speechStyle.trim()} />
              </div>
              <textarea id="f-speech" className={inputCls} style={inputStyle} rows={3} value={form.speechStyle} placeholder="口調全体の説明文。空なら未設定" onChange={(e) => set({ speechStyle: e.target.value, speechSources: { ...form.speechSources, style: e.target.value.trim() ? "manual" : null } })} />
              {!form.speechStyle.trim() && <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>現在: 未設定</p>}
            </div>
            <label className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" className="h-5 w-5" checked={form.speechInferred} onChange={(e) => set({ speechInferred: e.target.checked })} />
              この話し方は推定（バックグラウンドからの推定として「推定」と表示する）
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <TuningSlider label="口調の丁寧さ" value={form.tuning.politeness} lowLabel="くだけた" highLabel="とても丁寧" onChange={(v) => set({ tuning: { ...form.tuning, politeness: v } })} />
              <TuningSlider label="明るさ・テンション" value={form.tuning.brightness} lowLabel="落ち着いた" highLabel="ハイテンション" onChange={(v) => set({ tuning: { ...form.tuning, brightness: v } })} />
              <TuningSlider label="応答の長さ" value={form.tuning.length} lowLabel="短く" highLabel="長く詳しく" onChange={(v) => set({ tuning: { ...form.tuning, length: v } })} />
              <TuningSlider label="絵文字の量" value={form.tuning.emoji} lowLabel="使わない" highLabel="多め" onChange={(v) => set({ tuning: { ...form.tuning, emoji: v } })} />
            </div>
            <div>
              <label htmlFor="f-freenote" className="text-sm font-semibold">微調整の追加指示（自由入力）</label>
              <input id="f-freenote" className={inputCls} style={inputStyle} value={form.tuning.free_note} maxLength={1000} onChange={(e) => set({ tuning: { ...form.tuning, free_note: e.target.value } })} />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="font-display text-base font-bold">オプション: 音声設定（将来の音声会話用・今は保存のみ）</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="f-voice-kind" className="text-sm font-semibold">声の種類</label>
                <input id="f-voice-kind" className={inputCls} style={inputStyle} value={form.voiceKind} placeholder="未設定" onChange={(e) => set({ voiceKind: e.target.value })} />
              </div>
              <div>
                <label htmlFor="f-voice-speed" className="text-sm font-semibold">話速</label>
                <input id="f-voice-speed" className={inputCls} style={inputStyle} value={form.voiceSpeed} placeholder="未設定（例: 1.0）" onChange={(e) => set({ voiceSpeed: e.target.value })} />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="font-display text-base font-bold">オプション: アバター固有の記憶・切替設定</legend>
            <div>
              <label htmlFor="f-memory" className="text-sm font-semibold">アバター固有の記憶（このアバターのときだけ読み込まれます）</label>
              <textarea id="f-memory" className={inputCls} style={inputStyle} rows={3} value={form.avatarMemory} onChange={(e) => set({ avatarMemory: e.target.value })} />
            </div>
            <label className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" className="h-5 w-5" checked={form.useSharedInfo} onChange={(e) => set({ useSharedInfo: e.target.checked })} />
              共有情報（呼び方の既定値・好み・PC構成など）を使う
            </label>
            <p className="text-xs" style={{ color: "var(--dim)" }}>会話履歴は切り替えたアバターに一切渡しません（固定仕様のため設定項目はありません）。</p>
          </fieldset>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List / switch view
// ---------------------------------------------------------------------------

type View =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "detail"; id: string }
  | { kind: "trash" };

function ProfileCard({
  profile,
  onOpen,
  onPhrase,
}: {
  profile: Profile;
  onOpen: () => void;
  onPhrase: (phrase: string) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const switchMut = useMutation({
    mutationFn: async () => await api.requestSwitch({ profile_id: profile.id }),
    onSuccess: (r) => {
      // CR-04: show the canned phrase right after creating the request.
      onPhrase(r.phrase);
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "切替リクエストに失敗しました。"),
  });
  const favMut = useMutation({
    mutationFn: async () =>
      await api.toggleFavorite({ id: profile.id, favorite: !profile.favorite }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["profiles"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "お気に入りの変更に失敗しました。"),
  });

  // CR-10: every list card has the SAME fixed height (h-64) regardless of
  // the profile — long names/greetings/summaries are truncated inside
  // their fixed slots (line-clamp / truncate) and the action row is
  // pinned to the bottom, so nothing can grow or shrink a card. The card
  // is tinted and bordered with the profile's theme color, with a theme
  // band on top; text keeps the normal text color for readability.
  const color = profile.theme_color || DEFAULT_THEME_COLOR;
  return (
    <article
      className="flex h-64 flex-col overflow-hidden rounded-2xl"
      style={{
        background: `color-mix(in srgb, ${color} 6%, var(--surface))`,
        border: `2px solid ${color}`,
      }}
    >
      <div aria-hidden="true" className="h-1.5 shrink-0" style={{ background: color }} />
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <div className="flex items-start gap-3">
          <CardAvatarImage profile={profile} size={96} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <h3 className="font-display min-w-0 flex-1 truncate text-lg font-bold">
                {profile.name}
              </h3>
              <button
                type="button"
                aria-label={profile.favorite ? `${profile.name}のピン留めを外す` : `${profile.name}をピン留めする`}
                aria-pressed={profile.favorite}
                className="shrink-0 rounded-full px-1.5 text-xl"
                style={{ color: profile.favorite ? "var(--gold)" : "var(--dim)" }}
                onClick={() => favMut.mutate()}
              >
                {profile.favorite ? "★" : "☆"}
              </button>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {profile.is_active && (
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-xs font-bold whitespace-nowrap text-white"
                  style={{ background: "var(--teal)" }}
                >
                  ● 使用中
                </span>
              )}
              {profile.is_default && (
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
                  style={{ border: "1px solid var(--border)", color: "var(--dim)" }}
                >
                  既定
                </span>
              )}
              <span className="shrink-0">
                <PreparationBadge profile={profile} />
              </span>
              <span className="shrink-0">
                <PendingApplyBadge profile={profile} />
              </span>
              <span className="shrink-0">
                <PortrayalFailedBadge profile={profile} />
              </span>
            </div>
            <p
              className="mt-1 line-clamp-2 h-10 text-sm leading-5 break-words"
              style={{ color: "var(--text)" }}
            >
              {profile.greeting
                ? `「${profile.greeting}」`
                : "挨拶文は未設定です"}
            </p>
          </div>
        </div>
        <div className="mt-2 min-w-0">
          <p className="truncate text-sm" style={{ color: "var(--dim)" }}>
            {profile.summary ||
              (profile.background.text
                ? profile.background.text.split("\n")[0]
                : "未設定")}
          </p>
          <p className="mt-0.5 truncate text-xs" style={{ color: "var(--dim)" }}>
            呼び方: {profile.call_user_as ?? "未設定（既定）"} ／ 最終使用:{" "}
            {profile.last_used_at ? fmtDate(profile.last_used_at) : "未使用"}
          </p>
        </div>
        {error && (
          <p className="mt-1 truncate text-xs" style={{ color: "var(--accent)" }}>
            {error}
          </p>
        )}
        <div className="mt-auto flex gap-2 pt-2">
          {!profile.is_active ? (
            <button
              type="button"
              aria-label={`${profile.name}に切り替える`}
              className="flex-1 rounded-lg px-3 py-2 text-sm font-bold text-white"
              style={{ background: "var(--accent)" }}
              disabled={switchMut.isPending}
              onClick={() => switchMut.mutate()}
            >
              {switchMut.isPending ? "リクエスト作成中…" : "切り替える"}
            </button>
          ) : (
            <span
              className="flex flex-1 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold"
              style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
            >
              現在のアバターです
            </span>
          )}
          <button
            type="button"
            aria-label={`${profile.name}の詳細・編集を開く`}
            className="rounded-lg px-3 py-2 text-sm font-semibold"
            style={{ border: "1px solid var(--border)", background: "var(--surface)" }}
            onClick={onOpen}
          >
            詳細・編集
          </button>
        </div>
      </div>
    </article>
  );
}

// CR-09: フォーカス表示 — one profile fills the screen: a large avatar
// image, the name and main status badges, and a framed overview of the
// character background (link summary first, else an excerpt of the
// handwritten background text, else the profile summary; key points such
// as 私の扱い / 呼び方 are listed inside the same frame). Prev/next arrow
// buttons move through the same ordered list as 一覧表示 and wrap around
// at both ends. The main actions （切り替え / 詳細・編集 / ピン留め） work
// exactly like on the list cards.
// CR-09 follow-up 2: the image is NEVER cropped — the whole image fits
// inside a fixed-size frame (object-contain) over a blurred copy of
// itself, so portrait / landscape / square sources all show in full.
// Both frames (image and overview) have the same fixed size for every
// profile; overview content that does not fit scrolls inside its frame
// instead of resizing it.
// CR-11: carousel presentation — the edges of the previous/next
// profiles' cards peek in, semi-transparent, on both sides of the center
// card (absolutely positioned, so the center card's layout and fixed
// frame sizes never change). Switching slides the new card in from the
// travel direction while fading it in (theme.css keyframes; disabled
// under prefers-reduced-motion, loop wraps included). The arrow buttons
// have NO box at all — no border, no background — just a floating
// semi-transparent glyph over the peek area, with a generous tap target
// that grows slightly more opaque on hover/press.
function FocusView({
  profile,
  index,
  total,
  profiles,
  direction,
  prevProfile,
  nextProfile,
  onPrev,
  onNext,
  onJump,
  onOpen,
  onPhrase,
}: {
  profile: Profile;
  index: number;
  total: number;
  profiles: Profile[];
  direction: "next" | "prev";
  prevProfile: Profile | null;
  nextProfile: Profile | null;
  onPrev: () => void;
  onNext: () => void;
  onJump: (id: string) => void;
  onOpen: () => void;
  onPhrase: (phrase: string) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const switchMut = useMutation({
    mutationFn: async () => await api.requestSwitch({ profile_id: profile.id }),
    onSuccess: (r) => {
      onPhrase(r.phrase);
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "切替リクエストに失敗しました。"),
  });
  const favMut = useMutation({
    mutationFn: async () =>
      await api.toggleFavorite({ id: profile.id, favorite: !profile.favorite }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["profiles"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "お気に入りの変更に失敗しました。"),
  });

  const src = primaryThumbSrc(profile);
  // CR-10: the focus card is tinted/bordered with the theme color too.
  const color = profile.theme_color || DEFAULT_THEME_COLOR;
  const overviewRaw =
    profile.background.link_summary ||
    profile.background.text ||
    profile.summary ||
    "";
  const overview =
    overviewRaw.length > 400 ? `${overviewRaw.slice(0, 400)}…` : overviewRaw;

  // CR-11: floating arrows — no border, no background, no box. Only the
  // glyph, semi-transparent at rest and more opaque on hover/press, with
  // a 48px-wide, tall tap target floating over the peek strip.
  const arrowClass =
    "absolute top-1/2 z-20 flex w-12 -translate-y-1/2 items-center justify-center text-5xl font-bold opacity-50 transition hover:opacity-90 active:scale-110 active:opacity-100";
  const arrowStyle = {
    background: "transparent",
    border: "none",
    boxShadow: "none",
    color: "var(--accent)",
    height: 96,
    minHeight: 96,
    textShadow: "0 1px 6px var(--bg), 0 0 2px var(--bg)",
  } as const;

  // CR-11: a peek sliver of a neighbouring profile's card — a fixed-size
  // mini card (theme band + whole image + name) shifted so only its edge
  // shows inside the side strip, semi-transparent, purely decorative.
  const renderPeek = (p: Profile, side: "left" | "right") => {
    const pSrc = primaryThumbSrc(p);
    const pColor = p.theme_color || DEFAULT_THEME_COLOR;
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 z-0 w-7 overflow-hidden sm:w-10"
        style={side === "left" ? { left: 0 } : { right: 0 }}
      >
        <div
          className="absolute inset-y-2 w-36 overflow-hidden rounded-2xl opacity-45"
          style={{
            background: `color-mix(in srgb, ${pColor} 5%, var(--surface))`,
            border: `2px solid ${pColor}`,
            ...(side === "left"
              ? { left: 0, transform: "translateX(-72%)" }
              : { right: 0, transform: "translateX(72%)" }),
          }}
        >
          <div className="h-1.5 w-full" style={{ background: pColor }} />
          {pSrc ? (
            <img
              src={pSrc}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-28 w-full object-contain"
              style={{
                background: `color-mix(in srgb, ${pColor} 12%, var(--surface-alt))`,
              }}
            />
          ) : (
            <div
              className="font-display flex h-28 w-full items-center justify-center"
              style={{
                background: `color-mix(in srgb, ${pColor} 12%, var(--surface-alt))`,
                color: "var(--accent)",
                fontSize: 40,
              }}
            >
              {p.name.slice(0, 1) || "?"}
            </div>
          )}
          <p className="truncate p-2 text-sm font-bold">{p.name}</p>
        </div>
      </div>
    );
  };

  return (
    <section aria-label="フォーカス表示" className="mt-4">
      <div className="relative">
        {total > 1 && prevProfile && renderPeek(prevProfile, "left")}
        {total > 1 && nextProfile && renderPeek(nextProfile, "right")}
        <div className="relative z-10 px-7 sm:px-10">
        <article
          key={profile.id}
          className={`min-w-0 overflow-hidden rounded-2xl ${
            direction === "next" ? "focus-slide-next" : "focus-slide-prev"
          }`}
          style={{
            background: `color-mix(in srgb, ${color} 5%, var(--surface))`,
            border: `2px solid ${color}`,
          }}
        >
          <div aria-hidden="true" className="h-1.5 w-full" style={{ background: color }} />
          {src ? (
            <div
              className="relative h-60 w-full overflow-hidden sm:h-80"
              style={{
                background: `color-mix(in srgb, ${color} 12%, var(--surface-alt))`,
              }}
            >
              <img
                src={src}
                alt=""
                aria-hidden="true"
                decoding="async"
                className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-xl"
              />
              <img
                src={src}
                alt={`${profile.name}の画像`}
                decoding="async"
                className="relative h-full w-full object-contain"
              />
            </div>
          ) : (
            <div
              aria-label={`${profile.name}の画像は未設定`}
              className="font-display flex h-60 w-full flex-col items-center justify-center sm:h-80"
              style={{
                background: `color-mix(in srgb, ${color} 12%, var(--surface-alt))`,
                color: "var(--accent)",
                fontSize: 96,
                lineHeight: 1.1,
              }}
            >
              <span>{profile.name.slice(0, 1) || "?"}</span>
              <span
                className="mt-1 px-1 text-center"
                style={{ fontSize: 12, color: "var(--dim)", fontFamily: "inherit" }}
              >
                画像未設定
              </span>
            </div>
          )}
          <div className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-2xl font-bold break-all">
                {profile.name}
              </h2>
              {profile.is_active && (
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
                  style={{ background: "var(--teal)" }}
                >
                  ● 使用中
                </span>
              )}
              {profile.is_default && (
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-semibold"
                  style={{ border: "1px solid var(--border)", color: "var(--dim)" }}
                >
                  既定
                </span>
              )}
              <PreparationBadge profile={profile} showDetail />
              <PendingApplyBadge profile={profile} />
              <PortrayalFailedBadge profile={profile} />
              <button
                type="button"
                aria-label={profile.favorite ? `${profile.name}のピン留めを外す` : `${profile.name}をピン留めする`}
                aria-pressed={profile.favorite}
                className="ml-auto shrink-0 rounded-full px-2 text-2xl"
                style={{ color: profile.favorite ? "var(--gold)" : "var(--dim)" }}
                disabled={favMut.isPending}
                onClick={() => favMut.mutate()}
              >
                {profile.favorite ? "★" : "☆"}
              </button>
            </div>

            <div
              className="mt-3 h-72 overflow-y-auto rounded-xl p-3 sm:h-80"
              style={{
                background: `color-mix(in srgb, ${color} 7%, var(--surface-alt))`,
                border: `1.5px solid ${color}`,
              }}
            >
              <h3 className="text-xs font-bold" style={{ color: "var(--dim)" }}>
                キャラクター背景の概要
              </h3>
              <dl className="mt-2 text-sm">
                <div
                  className="grid grid-cols-[5.5rem_1fr] gap-x-3 py-1.5"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <dt className="font-semibold" style={{ color: "var(--dim)" }}>
                    挨拶文
                  </dt>
                  <dd className="break-words">
                    {profile.greeting ? `「${profile.greeting}」` : "未設定"}
                  </dd>
                </div>
                <div
                  className="grid grid-cols-[5.5rem_1fr] gap-x-3 py-1.5"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <dt className="font-semibold" style={{ color: "var(--dim)" }}>
                    要約
                  </dt>
                  <dd className="break-words whitespace-pre-wrap">
                    {overview || "未設定"}
                  </dd>
                </div>
                <div
                  className="grid grid-cols-[5.5rem_1fr] gap-x-3 py-1.5"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <dt className="font-semibold" style={{ color: "var(--dim)" }}>
                    私の扱い
                  </dt>
                  <dd className="break-words">
                    {profile.background.user_relationship ??
                      "未指定（背景や呼び方から自然に推定）"}
                  </dd>
                </div>
                <div
                  className="grid grid-cols-[5.5rem_1fr] gap-x-3 py-1.5"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <dt className="font-semibold" style={{ color: "var(--dim)" }}>
                    呼び方
                  </dt>
                  <dd className="break-words">
                    {profile.call_user_as ?? "未設定（既定）"}
                  </dd>
                </div>
                <div
                  className="grid grid-cols-[5.5rem_1fr] gap-x-3 py-1.5"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <dt className="font-semibold" style={{ color: "var(--dim)" }}>
                    最終使用
                  </dt>
                  <dd>
                    {profile.last_used_at ? fmtDate(profile.last_used_at) : "未使用"}
                  </dd>
                </div>
              </dl>
            </div>

            {error && (
              <p className="mt-2 text-sm" style={{ color: "var(--accent)" }}>
                {error}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              {!profile.is_active ? (
                <button
                  type="button"
                  aria-label={`${profile.name}に切り替える`}
                  className="flex-1 rounded-lg px-3 py-2.5 text-sm font-bold text-white"
                  style={{ background: "var(--accent)" }}
                  disabled={switchMut.isPending}
                  onClick={() => switchMut.mutate()}
                >
                  {switchMut.isPending ? "リクエスト作成中…" : "切り替える"}
                </button>
              ) : (
                <span
                  className="flex flex-1 items-center justify-center rounded-lg px-3 py-2.5 text-sm font-semibold"
                  style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
                >
                  現在のアバターです
                </span>
              )}
              <button
                type="button"
                aria-label={`${profile.name}の詳細・編集を開く`}
                className="rounded-lg px-3 py-2.5 text-sm font-semibold"
                style={{ border: "1px solid var(--border)" }}
                onClick={onOpen}
              >
                詳細・編集
              </button>
            </div>
          </div>
        </article>
        </div>
        {total > 1 && (
          <>
            <button
              type="button"
              aria-label="前のプロファイル"
              className={`${arrowClass} left-0`}
              style={arrowStyle}
              onClick={onPrev}
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="次のプロファイル"
              className={`${arrowClass} right-0`}
              style={arrowStyle}
              onClick={onNext}
            >
              ›
            </button>
          </>
        )}
      </div>

      <div className="mt-3 flex flex-col items-center gap-1.5">
        <p className="text-sm font-semibold" aria-live="polite">
          {index + 1} / {total}
        </p>
        {total > 1 && (
          <div className="flex flex-wrap justify-center gap-1.5">
            {profiles.map((p, i) => (
              <button
                key={p.id}
                type="button"
                aria-label={`${i + 1}番目（${p.name}）へ移動`}
                aria-current={i === index ? "true" : undefined}
                className="rounded-full transition"
                style={{
                  width: i === index ? 22 : 10,
                  height: 10,
                  minHeight: 10,
                  background:
                    i === index
                      ? (p.theme_color || DEFAULT_THEME_COLOR)
                      : "var(--border)",
                }}
                onClick={() => onJump(p.id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// CR-26: グリッド表示 — profiles in a 5-column grid (横5×縦n). Each
// tile shows the thumbnail and the name, so many profiles can be
// scanned at a glance. Tapping the thumbnail/name area opens that
// profile's detail/edit screen, same as the list and focus cards.
// The thumbnail follows the same whole-image rule as the other views
// (object-contain over a blurred copy of itself; a monogram
// placeholder occupies the identical square frame when no image is
// set).
// CR-27: each tile also carries a compact 切替 button under the name,
// wired to the same requestSwitch flow as the list/focus cards (the
// canned phrase surfaces in the shared PhraseBox above the grid).
// The active profile shows a 使用中 label instead of the button, and
// a profile with an open switch request shows 切替待ち (disabled).
function GridTile({
  profile,
  onOpen,
  onPhrase,
}: {
  profile: Profile;
  onOpen: () => void;
  onPhrase: (phrase: string) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const switchMut = useMutation({
    mutationFn: async () => await api.requestSwitch({ profile_id: profile.id }),
    onSuccess: (r) => {
      onPhrase(r.phrase);
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "切替リクエストに失敗しました。"),
  });
  const src = primaryThumbSrc(profile);
  const color = profile.theme_color || DEFAULT_THEME_COLOR;
  const switchPending = profile.pending_switch_count > 0;
  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-xl"
      style={{
        background: `color-mix(in srgb, ${color} 6%, var(--surface))`,
        border: `1.5px solid ${color}`,
      }}
    >
      <button
        type="button"
        aria-label={`${profile.name}の詳細・編集を開く`}
        title={profile.name}
        className="block w-full text-left transition hover:opacity-90 active:scale-[0.98]"
        onClick={onOpen}
      >
        <span className="relative block aspect-square w-full overflow-hidden" style={{ background: `color-mix(in srgb, ${color} 12%, var(--surface-alt))` }}>
          {src ? (
            <>
              <img
                src={src}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-lg"
              />
              <img
                src={src}
                alt={`${profile.name}のサムネイル`}
                loading="lazy"
                decoding="async"
                className="relative h-full w-full object-contain"
              />
            </>
          ) : (
            <span
              aria-label={`${profile.name}の画像は未設定`}
              className="font-display flex h-full w-full items-center justify-center"
              style={{ color: "var(--accent)", fontSize: 28, lineHeight: 1.1 }}
            >
              {profile.name.slice(0, 1) || "?"}
            </span>
          )}
        </span>
        <span className="block w-full truncate px-1 py-1.5 text-center text-[11px] leading-4 font-semibold sm:px-1.5 sm:text-sm sm:leading-5">
          {profile.name}
        </span>
      </button>
      <div className="mt-auto px-1 pb-1.5 sm:px-1.5">
        {profile.is_active ? (
          <span
            className="flex items-center justify-center rounded-md px-1 py-1 text-[11px] font-bold whitespace-nowrap text-white sm:text-xs"
            style={{ background: "var(--teal)" }}
          >
            ● 使用中
          </span>
        ) : (
          <button
            type="button"
            aria-label={`${profile.name}に切り替える`}
            className="w-full rounded-md px-1 py-1 text-[11px] font-bold whitespace-nowrap text-white disabled:opacity-60 sm:text-xs"
            style={{ background: "var(--accent)" }}
            disabled={switchMut.isPending || switchPending}
            onClick={() => switchMut.mutate()}
          >
            {switchMut.isPending ? "作成中…" : switchPending ? "切替待ち" : "切替"}
          </button>
        )}
        {error && (
          <p className="mt-1 text-center text-[10px] leading-3" style={{ color: "var(--accent)" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function GridView({
  profiles,
  onOpen,
  onPhrase,
}: {
  profiles: Profile[];
  onOpen: (id: string) => void;
  onPhrase: (phrase: string) => void;
}) {
  return (
    <section aria-label="グリッド表示" className="mt-4">
      <div className="grid grid-cols-5 gap-2 sm:gap-3">
        {profiles.map((p) => (
          <GridTile
            key={p.id}
            profile={p}
            onOpen={() => onOpen(p.id)}
            onPhrase={onPhrase}
          />
        ))}
      </div>
    </section>
  );
}

function ListView({ navigate }: { navigate: (v: View) => void }) {
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<"last_used" | "name" | "created">("last_used");
  const [search, setSearch] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [importError, setImportError] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  // CR-09: display mode. Default is the classic list; focus mode shows one
  // profile large with prev/next arrows. CR-26 adds grid mode (5-column
  // tiles, thumbnail + name only). All modes share the same search/sort
  // state, and focusId survives mode switches.
  const [mode, setMode] = useState<"list" | "focus" | "grid">("list");
  const [focusId, setFocusId] = useState<string | null>(null);
  // CR-11: travel direction of the last focus move, driving the
  // slide+fade animation direction in the focus carousel.
  const [focusDir, setFocusDir] = useState<"next" | "prev">("next");

  const list = useQuery({
    queryKey: ["profiles", sort],
    queryFn: () => api.listProfiles({ sort }),
  });

  // CR-15: recent generation requests are fetched including failed ones
  // (not only open), so failed requests can be dismissed from the list
  // screen too. Open profile_apply requests keep their own 反映待ち panel
  // below; every other deletable request (open or failed) is listed in
  // the 生成リクエスト panel.
  const openGen = useQuery({
    queryKey: ["gen-open"],
    queryFn: () =>
      api.listGenerationRequests({ only_open: false, limit: 30 }),
  });
  const openApplies = (openGen.data?.requests ?? []).filter(
    (r) =>
      r.kind === "profile_apply" &&
      (r.status === "pending" || r.status === "processing"),
  );
  const dismissibleGen = (openGen.data?.requests ?? []).filter(
    (r) =>
      canDeleteRequest(r.status) &&
      !(
        r.kind === "profile_apply" &&
        (r.status === "pending" || r.status === "processing")
      ),
  );

  const importMut = useMutation({
    mutationFn: async (json: string) => await api.importProfile({ json }),
    onSuccess: () => {
      setImportError("");
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (e) =>
      setImportError(e instanceof Error ? e.message : "読み込みに失敗しました。"),
  });

  const profiles = useMemo(() => {
    const all = list.data?.profiles ?? [];
    const q = search.trim();
    if (!q) return all;
    return all.filter((p) => p.name.includes(q));
  }, [list.data, search]);

  const active = (list.data?.profiles ?? []).find((p) => p.is_active);
  const rest = profiles.filter((p) => p.id !== active?.id);
  const shownActive =
    active && (!search.trim() || active.name.includes(search.trim()))
      ? active
      : undefined;
  const defaultProfile = (list.data?.profiles ?? []).find((p) => p.is_default);

  // CR-09: focus navigation runs over the same filtered/sorted sequence
  // the list shows (active profile included). When focusId is unset or no
  // longer in the sequence, focus starts at the active profile (or the
  // first one). Prev/next wrap around at both ends.
  const focusIndex = useMemo(() => {
    if (profiles.length === 0) return 0;
    const byId = profiles.findIndex((p) => p.id === focusId);
    if (byId >= 0) return byId;
    const byActive = profiles.findIndex((p) => p.is_active);
    return byActive >= 0 ? byActive : 0;
  }, [profiles, focusId]);
  const focusProfile = profiles[focusIndex];
  const focusStep = (delta: number) => {
    if (profiles.length === 0) return;
    setFocusDir(delta >= 0 ? "next" : "prev");
    const next =
      profiles[(focusIndex + delta + profiles.length) % profiles.length];
    if (next) setFocusId(next.id);
  };
  // CR-11: neighbours whose card edges peek in on both sides (wrapping
  // around at the ends, same as the navigation itself).
  const focusPrevProfile =
    profiles.length > 1
      ? (profiles[(focusIndex - 1 + profiles.length) % profiles.length] ?? null)
      : null;
  const focusNextProfile =
    profiles.length > 1
      ? (profiles[(focusIndex + 1) % profiles.length] ?? null)
      : null;

  // Arrow keys also move focus (ignored while typing in a field).
  useEffect(() => {
    if (mode !== "focus") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "ArrowLeft") focusStep(-1);
      else if (e.key === "ArrowRight") focusStep(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // focusStep closes over the current sequence/index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, focusIndex, profiles]);

  const resetMut = useMutation({
    mutationFn: async () =>
      await api.requestSwitch({ profile_id: defaultProfile?.id ?? "" }),
    onSuccess: (r) => {
      setPhrase(r.phrase);
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-40 flex-1">
          <label htmlFor="search" className="sr-only">
            名前で検索
          </label>
          <input
            id="search"
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
            placeholder="名前で検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="sort" className="sr-only">
            並べ替え
          </label>
          <select
            id="sort"
            className="rounded-lg px-2 py-2 text-sm"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="last_used">最終使用順</option>
            <option value="name">名前順</option>
            <option value="created">作成順</option>
          </select>
        </div>
        <button
          type="button"
          aria-label="新しいアバターを作成"
          className="rounded-lg px-4 py-2 text-sm font-bold text-white"
          style={{ background: "var(--accent)" }}
          onClick={() => navigate({ kind: "create" })}
        >
          ＋ 作成
        </button>
      </div>

      <div
        className="mt-3 inline-flex overflow-hidden rounded-lg"
        style={{ border: "1.5px solid var(--border)" }}
        role="group"
        aria-label="表示モード"
      >
        <button
          type="button"
          aria-label="一覧表示"
          aria-pressed={mode === "list"}
          className="px-4 py-2 text-sm font-bold"
          style={
            mode === "list"
              ? { background: "var(--accent)", color: "var(--accent-ink)" }
              : { background: "var(--surface)", color: "var(--dim)" }
          }
          onClick={() => setMode("list")}
        >
          一覧表示
        </button>
        <button
          type="button"
          aria-label="フォーカス表示"
          aria-pressed={mode === "focus"}
          className="px-4 py-2 text-sm font-bold"
          style={
            mode === "focus"
              ? { background: "var(--accent)", color: "var(--accent-ink)" }
              : { background: "var(--surface)", color: "var(--dim)" }
          }
          onClick={() => setMode("focus")}
        >
          フォーカス表示
        </button>
        <button
          type="button"
          aria-label="グリッド表示"
          aria-pressed={mode === "grid"}
          className="px-4 py-2 text-sm font-bold"
          style={
            mode === "grid"
              ? { background: "var(--accent)", color: "var(--accent-ink)" }
              : { background: "var(--surface)", color: "var(--dim)" }
          }
          onClick={() => setMode("grid")}
        >
          グリッド表示
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="ゴミ箱を開く"
          className="rounded-lg px-3 py-1.5 text-sm"
          style={{ border: "1px solid var(--border)" }}
          onClick={() => navigate({ kind: "trash" })}
        >
          ゴミ箱
        </button>
        <button
          type="button"
          aria-label="プロファイルJSONを読み込む"
          className="rounded-lg px-3 py-1.5 text-sm font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
          style={{ border: "1.5px solid var(--border)", background: "var(--surface-alt)" }}
          onClick={() => importRef.current?.click()}
        >
          JSONを読み込む
        </button>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          aria-label="読み込むJSONファイル"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const text = await file.text();
            importMut.mutate(text);
          }}
        />
        {defaultProfile && !defaultProfile.is_active && (
          <button
            type="button"
            aria-label="既定アバターに戻す"
            className="rounded-lg px-3 py-1.5 text-sm font-semibold"
            style={{ border: "1px solid var(--border)" }}
            disabled={resetMut.isPending}
            onClick={() => resetMut.mutate()}
          >
            既定アバターに戻す
          </button>
        )}
      </div>
      {importError && (
        <p className="mt-2 text-sm" style={{ color: "var(--accent)" }}>
          {importError}
        </p>
      )}
      {phrase && <PhraseBox phrase={phrase} />}

      {list.isPending && <p className="mt-6 text-sm">読み込み中…</p>}
      {list.error && (
        <p className="mt-6 text-sm" style={{ color: "var(--accent)" }}>
          読み込みに失敗しました。再度お試しください。
        </p>
      )}
      {list.data && list.data.profiles.length === 0 && (
        <p className="mt-6 text-sm" style={{ color: "var(--dim)" }}>
          プロファイルがまだありません。「＋ 作成」から作れます。
        </p>
      )}

      {mode === "focus" && list.data && profiles.length === 0 && (
        <p className="mt-6 text-sm" style={{ color: "var(--dim)" }}>
          該当するプロファイルがありません。検索条件を変えるか、一覧表示で確認してください。
        </p>
      )}
      {mode === "focus" && focusProfile && (
        <FocusView
          profile={focusProfile}
          index={focusIndex}
          total={profiles.length}
          profiles={profiles}
          direction={focusDir}
          prevProfile={focusPrevProfile}
          nextProfile={focusNextProfile}
          onPrev={() => focusStep(-1)}
          onNext={() => focusStep(1)}
          onJump={(id) => {
            const target = profiles.findIndex((p) => p.id === id);
            if (target >= 0) setFocusDir(target >= focusIndex ? "next" : "prev");
            setFocusId(id);
          }}
          onOpen={() => navigate({ kind: "detail", id: focusProfile.id })}
          onPhrase={(ph) => setPhrase(ph)}
        />
      )}

      {mode === "grid" && list.data && profiles.length === 0 && (
        <p className="mt-6 text-sm" style={{ color: "var(--dim)" }}>
          該当するプロファイルがありません。検索条件を変えるか、一覧表示で確認してください。
        </p>
      )}
      {mode === "grid" && profiles.length > 0 && (
        <GridView
          profiles={profiles}
          onOpen={(id) => navigate({ kind: "detail", id })}
          onPhrase={(ph) => setPhrase(ph)}
        />
      )}

      {/* CR-10: the active profile uses the SAME unified ProfileCard as
          every other profile (same fixed height, whole-image frame,
          theme color) — it is only marked 使用中 inside the card. */}
      {mode === "list" && shownActive && (
        <section aria-label="アクティブアバター" className="mt-4">
          <ProfileCard
            profile={shownActive}
            onOpen={() => navigate({ kind: "detail", id: shownActive.id })}
            onPhrase={(ph) => setPhrase(ph)}
          />
        </section>
      )}

      {mode === "list" && (
        <div className="mt-4 space-y-3">
          {rest.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              onOpen={() => navigate({ kind: "detail", id: p.id })}
              onPhrase={(ph) => setPhrase(ph)}
            />
          ))}
        </div>
      )}

      {list.data && (
        <SwitchStatusPanel requests={list.data.switch_requests} />
      )}

      {openApplies.length > 0 && (
        <section aria-label="反映待ちのプロファイル更新" className="mt-4">
          <h2 className="font-display text-base font-bold">
            反映待ちのプロファイル更新
          </h2>
          <ul className="mt-2 space-y-2">
            {openApplies.map((r) => (
              <li
                key={r.id}
                className="rounded-xl p-3"
                style={{
                  background: "var(--surface)",
                  border: "1.5px solid var(--gold)",
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="inline-block rounded-full px-2 py-0.5 text-xs font-bold text-white"
                    style={{ background: "var(--gold)" }}
                  >
                    ⏳ 反映待ち
                  </span>
                  <span className="text-sm font-semibold">
                    {r.profile_name ?? "（プロファイル不明）"}
                  </span>
                  <StatusChip status={r.status} />
                  <span className="text-xs" style={{ color: "var(--dim)" }}>
                    {fmtDate(r.created_at)}
                  </span>
                  <span className="ml-auto">
                    <RequestDeleteButton
                      ariaSubject={`「${r.profile_name ?? "プロファイル不明"}」のプロファイル反映リクエスト`}
                      deleteFn={async () =>
                        await api.deleteGenerationRequest({ request_id: r.id })
                      }
                    />
                  </span>
                </div>
                <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
                  「保存して今すぐ反映」のリクエストです。下の定型文をチャットに貼って送信すると、口調・名前・呼び方が即時適用され、画像が変わっていれば候補生成→選択→セットまで進みます。
                </p>
                {r.phrase && <PhraseBox phrase={r.phrase} kind="apply" />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* CR-15: every other deletable generation request (open or failed,
          any kind except the open profile_apply ones shown above) can be
          discarded from here. Completed requests are history and are not
          listed. */}
      {dismissibleGen.length > 0 && (
        <section aria-label="生成リクエスト（未処理・失敗）" className="mt-4">
          <h2 className="font-display text-base font-bold">
            生成リクエスト（未処理・失敗）
          </h2>
          <ul className="mt-2 space-y-2">
            {dismissibleGen.map((r) => (
              <li
                key={r.id}
                className="rounded-xl p-3"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">
                    {genKindLabel(r.kind)}
                  </span>
                  <span className="text-sm">
                    {r.profile_name ?? "（プロファイル不明）"}
                  </span>
                  <StatusChip status={r.status} />
                  <span className="text-xs" style={{ color: "var(--dim)" }}>
                    {fmtDate(r.created_at)}
                  </span>
                  <span className="ml-auto">
                    <RequestDeleteButton
                      ariaSubject={`「${r.profile_name ?? "プロファイル不明"}」の${genKindLabel(r.kind)}リクエスト`}
                      deleteFn={async () =>
                        await api.deleteGenerationRequest({ request_id: r.id })
                      }
                    />
                  </span>
                </div>
                {r.status === "failed" && (
                  <p className="mt-1 text-sm" style={{ color: "var(--accent)" }}>
                    失敗理由: {r.reason ?? "理由不明"}
                  </p>
                )}
                {(r.status === "pending" || r.status === "processing") && (
                  <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
                    未処理のリクエストです。消去すると破棄され、処理対象から外れます。
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create wizard
// ---------------------------------------------------------------------------

// CR-24: 「キャラチャットに反映する」 checkbox for the create/edit
// forms. The reflection destination is discovered by the server under
// the receiver interop contract (a getAvatarReceiverInfo
// self-introduction, or the legacy import interface) — never a fixed
// app. While the status is loading the checkbox stays off and
// disabled; when a target exists it is auto-checked (the caller
// computes the effective checked state) and shows 「自動反映可能」;
// when none exists it stays off and disabled with 「自動反映不可」,
// and saving is completely unaffected.
type CharaSyncStatus = {
  available: boolean;
  target_slug: string | null;
  target_name: string | null;
  discovery_method: "handshake" | "legacy" | null;
};

function CharaChatSyncField({
  status,
  checked,
  onChange,
  lastSyncedAt,
}: {
  status: CharaSyncStatus | undefined;
  checked: boolean;
  onChange: (v: boolean) => void;
  lastSyncedAt?: string | null;
}) {
  const loading = status === undefined;
  const available = !!status?.available;
  const targetLabel = status?.target_name ?? status?.target_slug ?? null;
  return (
    <fieldset
      className="rounded-xl p-3"
      style={{ border: "1.5px solid var(--teal)", background: "var(--surface)" }}
    >
      <legend className="font-display px-1 text-base font-bold">
        キャラチャット連携
      </legend>
      <label className="flex min-h-9 items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          aria-label="キャラチャットに反映する"
          className="h-5 w-5 shrink-0"
          checked={available && checked}
          disabled={!available}
          onChange={(e) => onChange(e.target.checked)}
        />
        キャラチャットに反映する
        {loading ? (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-bold"
            style={{ border: "1.5px solid var(--border)", color: "var(--dim)" }}
          >
            連携先を確認中…
          </span>
        ) : available ? (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
            style={{ background: "var(--teal)" }}
          >
            自動反映可能
          </span>
        ) : (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-bold"
            style={{ border: "1.5px solid var(--accent)", color: "var(--accent)" }}
          >
            自動反映不可
          </span>
        )}
      </label>
      {loading ? (
        <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>
          連携できるアプリがあるか確認しています。
        </p>
      ) : available ? (
        <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
          連携先アプリ{targetLabel ? `「${targetLabel}」` : ""}が見つかりました。オンのまま保存すると、保存と同時にこのプロファイルの反映リクエストが自動で作成され、連携先へ取り込まれます（変更がなければスキップされます）。
          {lastSyncedAt
            ? ` 前回の反映: ${fmtDate(lastSyncedAt)}`
            : " まだ反映されたことはありません。"}
        </p>
      ) : (
        <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
          プロファイルの受け口（自己紹介 getAvatarReceiverInfo、または取り込み用インターフェース）を持つアプリがこの環境で見つからないため、自動反映は利用できません。保存や他の機能には影響しません。
        </p>
      )}
    </fieldset>
  );
}

function CreateView({ navigate }: { navigate: (v: View) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [showOptional, setShowOptional] = useState(false);
  const [imageMode, setImageMode] = useState<"upload" | "url" | "elements" | "none">("url");
  const [pendingUpload, setPendingUpload] = useState<{
    dataBase64: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    preview: string;
  } | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [nameError, setNameError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  // CR-24: chara-chat auto-sync. The status query asks the server
  // whether a receiver app was discovered in this environment; the
  // checkbox follows availability (auto-checked) until the user
  // explicitly toggles it (syncOverride).
  const charaStatus = useQuery({
    queryKey: ["chara-sync-status"],
    queryFn: () => api.getCharaChatSyncStatus({}),
  });
  const [syncOverride, setSyncOverride] = useState<boolean | null>(null);
  const syncChecked = syncOverride ?? charaStatus.data?.available ?? false;

  // CR-10: live theme-color acquisition while creating. When a base
  // image is chosen (upload preview or a readable URL), its dominant
  // color becomes the theme color (auto) so the user can confirm it in
  // the テーマカラー section before saving; without an image, the color
  // is inferred from the appearance elements. A manual pick is never
  // touched by either path.
  const themeSourceRef = useRef(form.themeColorSource);
  themeSourceRef.current = form.themeColorSource;
  useEffect(() => {
    const src =
      pendingUpload?.preview ||
      (imageMode === "url" && imageUrl.trim() ? imageUrl.trim() : null);
    if (!src) return;
    let cancelled = false;
    void extractDominantColor(src).then((hex) => {
      if (cancelled || !hex) return;
      if (themeSourceRef.current === "manual") return;
      setForm((prev) =>
        prev.themeColorSource === "manual" || prev.themeColor === hex
          ? prev
          : { ...prev, themeColor: hex, themeColorSource: "auto" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [pendingUpload?.preview, imageMode, imageUrl]);
  useEffect(() => {
    if (pendingUpload || (imageMode === "url" && imageUrl.trim())) return;
    if (themeSourceRef.current === "manual") return;
    const derived = deriveThemeColorFromElements(form.elements);
    setForm((prev) => {
      if (prev.themeColorSource === "manual") return prev;
      const next = derived ?? DEFAULT_THEME_COLOR;
      const nextSource: ThemeColorSource = derived ? "auto" : "default";
      if (prev.themeColor === next && prev.themeColorSource === nextSource)
        return prev;
      return { ...prev, themeColor: next, themeColorSource: nextSource };
    });
  }, [form.elements, imageMode, pendingUpload, imageUrl]);

  async function save(switchAfter: boolean) {
    if (!form.name.trim()) {
      setNameError("名前は必須です。");
      return;
    }
    if (imageMode === "url" && imageUrl.trim() && !/^https?:\/\//.test(imageUrl.trim())) {
      setSaveError("画像URLの形式が正しくありません。");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const effectiveImageMode = imageMode === "url" && !imageUrl.trim() ? "none" : imageMode;
      const data = formToData({
        ...form,
        imageBaseType:
          effectiveImageMode === "elements" ? "elements" : effectiveImageMode === "none" ? "none" : "image",
        imageRef:
          effectiveImageMode === "url" ? imageUrl : form.imageRef,
      });
      // CR-10: final theme acquisition at save time — if the user did
      // not pick a color manually and a base image exists, extract its
      // dominant color now (the live effect usually already did; this
      // covers a just-pasted URL). The same candidate is passed to the
      // image registration calls below, which re-apply it server-side.
      let themeCandidate: string | null = null;
      if (form.themeColorSource !== "manual") {
        const srcForColor =
          pendingUpload?.preview ||
          (effectiveImageMode === "url" ? imageUrl.trim() : "");
        if (srcForColor) {
          themeCandidate = await extractDominantColor(srcForColor);
          if (themeCandidate) {
            data.theme_color = themeCandidate;
            data.theme_color_source = "auto";
          }
        }
      }
      // Initial preparation hints: server will recompute, but set greeting pending
      data.preparation = {
        image: effectiveImageMode === "elements" ? "pending" : effectiveImageMode === "none" ? "none" : "done",
        link_summary: form.bgLinks.some((l) => l.trim()) ? "pending" : "none",
        greeting: "pending",
        video: form.bgVideoUrls.some((l) => l.trim()) ? "pending" : "none",
        status: "preparing",
      };
      const created = await api.createProfile({ name: form.name.trim(), data, favorite: form.favorite, sync_to_chara_chat: syncChecked });
      const id = created.id;
      if (effectiveImageMode === "upload" && pendingUpload) {
        await api.uploadImage({
          profile_id: id,
          data_base64: pendingUpload.dataBase64,
          mime_type: pendingUpload.mimeType,
          make_primary: true,
          theme_color_candidate: themeCandidate,
        });
      }
      const urlToRegister = effectiveImageMode === "url" ? imageUrl.trim() : "";
      if (urlToRegister.length > 0) {
        await api.addImageByUrl({
          profile_id: id,
          url: urlToRegister,
          make_primary: true,
          theme_color_candidate: themeCandidate,
        });
      }
      if (effectiveImageMode === "elements") {
        await api.createGenerationRequest({
          profile_id: id,
          kind: "image_generation",
          payload: JSON.stringify({
            name: form.name.trim(),
            elements: form.elements,
            note: "要素指定からオリジナル画像を生成してください",
          }),
        });
      }
      // D-5: the link_summary and trial_conversation requests are no
      // longer queued from here — createProfile's server-side
      // preparation guarantee (D-1) queues exactly one of each during
      // creation, from the saved profile, so no creation path can
      // miss them. (The server-side trial note is the wording this
      // form used to send, kept verbatim as a server constant.)
      // R-4 (CR-24): createProfile only stores the sync preference —
      // the chara_chat_sync request is queued HERE, after every other
      // follow-up step (image registration and the image_generation
      // request; the link_summary / trial_conversation requests are
      // queued server-side during createProfile itself, D-1/D-5) has
      // completed, so the reflection carries the finished profile. A
      // failure of this call does not fail the creation; the sync
      // simply stays unqueued (charaSyncQueued stays false).
      let charaSyncQueued = false;
      if (syncChecked) {
        try {
          await api.createGenerationRequest({
            profile_id: id,
            kind: "chara_chat_sync",
            payload: "{}",
          });
          charaSyncQueued = true;
        } catch {
          charaSyncQueued = false;
        }
      }
      void charaSyncQueued;
      if (switchAfter) {
        await api.requestSwitch({ profile_id: id });
      }
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
      navigate({ kind: "detail", id });
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : "保存に失敗しました。もう一度お試しください。",
      );
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full rounded-lg px-3 py-2 text-sm";
  const inputStyle = { background: "var(--surface)", border: "1px solid var(--border)" };

  // Live preview data
  const previewSrc = pendingUpload?.preview || (imageUrl.trim() ? imageUrl.trim() : null);

  return (
    <div>
      <div className="flex items-center gap-2">
        <button type="button" aria-label="一覧に戻る" className="rounded-lg px-3 py-2 text-sm" style={{ border: "1px solid var(--border)" }} onClick={() => navigate({ kind: "list" })}>← 一覧</button>
        <h2 className="font-display text-xl font-bold">新しいアバターを作成</h2>
      </div>
      <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>最短経路: ①名前 ②参考URL（背景） ③ベース画像（アップロード/URL）— この3つだけで保存できます。保存すると挨拶文と参考リンク要約が自動で準備され、詳細画面で「準備中 → 利用可能」のステータスとプレビューが見られます。</p>
      <p className="mt-3 rounded-xl p-3 text-xs leading-relaxed" style={{ background: "var(--surface-alt)", color: "var(--dim)" }}>{IMAGE_NOTICE}</p>

      {/* Preview strip — CR-10: bordered with the (live-acquired) theme color */}
      <section aria-label="作成プレビュー" className="mt-4 rounded-2xl p-3" style={{ background: `color-mix(in srgb, ${form.themeColor} 5%, var(--surface))`, border: `2px solid ${form.themeColor}` }}>
        <h3 className="font-display text-base font-bold">プレビュー</h3>
        <div className="mt-2 flex items-start gap-3">
          {previewSrc ? (
            <img src={previewSrc} alt="作成中のアバター画像プレビュー" className="h-24 w-24 shrink-0 rounded-xl object-contain" style={{ background: "var(--surface-alt)", border: `1.5px solid ${form.themeColor}` }} />
          ) : imageMode === "elements" ? (
            <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl text-xs text-center p-2" style={{ background: "var(--surface-alt)", color: "var(--dim)" }}>要素指定<br/>保存後に生成を依頼します</div>
          ) : (
            <div className="flex h-24 w-24 shrink-0 flex-col items-center justify-center rounded-xl" style={{ background: "var(--surface-alt)", color: "var(--accent)", border: `1.5px solid ${form.themeColor}` }}><span className="text-2xl">{form.name.slice(0,1) || "?"}</span><span className="text-[10px]" style={{ color: "var(--dim)" }}>画像未設定</span></div>
          )}
          <div className="min-w-0 flex-1">
            <p className="font-bold break-all">{form.name || "（名前未入力）"}</p>
            <p className="text-sm" style={{ color: "var(--dim)" }}>{form.summary || "要約未設定"}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <span aria-hidden="true" className="inline-block h-4 w-4 rounded" style={{ background: form.themeColor, border: "1px solid var(--border)" }} />
              テーマカラー: {form.themeColor}
              <ThemeSourceBadge source={form.themeColorSource} />
            </p>
            {form.userRelationship.trim() && <p className="mt-1 text-sm">私の扱い: {form.userRelationship.trim()}</p>}
            {form.portrayalFocus.trim() && <p className="mt-1 text-sm">演じる姿・状況: {form.portrayalFocus.trim()}</p>}
            <p className="mt-1 text-sm">フレーバーの量（一括・既定）: {form.flavorLevel}/5（{FLAVOR_LEVEL_DESCRIPTIONS[form.flavorLevel] ?? ""}）／ 項目: {form.flavorTraits.filter((t) => t.label.trim()).length}件</p>
            {(() => {
              const enabledTraits = form.flavorTraits.filter((t) => t.enabled && t.label.trim());
              if (enabledTraits.length === 0) return null;
              return (
                <ul className="mt-1 space-y-2 text-sm">
                  {enabledTraits.map((t, idx) => {
                    const examples = t.examples.map((e) => e.trim()).filter(Boolean);
                    const eff = effectiveFlavorFrequency(t, form.flavorLevel);
                    const differs = flavorFrequencyIsCustom(t, form.flavorLevel);
                    return (
                      <li key={t.id || idx} className="rounded-lg p-2" style={{ background: differs ? "color-mix(in srgb, var(--gold) 8%, var(--surface-alt))" : "var(--surface-alt)", border: differs ? "1.5px solid var(--gold)" : "1px solid transparent" }}>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{t.label}</span>
                          <SpeechSourceBadge source={t.source} hasValue />
                          <FlavorEffectiveBadge trait={t} globalLevel={form.flavorLevel} />
                          {eff === 0 && <span className="text-xs font-bold" style={{ color: "var(--accent)" }}>この項目は出ません</span>}
                          {traitNeedsAutoExamples(t) && <AutoExamplesPendingBadge />}
                          {t.scenes.length > 0 && (
                            <span className="text-xs" style={{ color: "var(--dim)" }}>
                              場面: {t.scenes.join("・")}
                            </span>
                          )}
                        </span>
                        {examples.length > 0 && (
                          <span className="mt-0.5 block">
                            フレーバーの例: 「{examples[0]}」
                            {examples.length > 1 && (
                              <span style={{ color: "var(--dim)" }}>（ほか{examples.length - 1}件）</span>
                            )}
                          </span>
                        )}
                        {traitNeedsAutoExamples(t) && (
                          <span className="mt-0.5 block text-xs" style={{ color: "var(--dim)" }}>
                            例文は自動作成待ちです（保存時にチャット側へ依頼されます）
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              );
            })()}
            <p className="mt-1 text-sm rounded-lg p-2" style={{ background: "var(--surface-alt)" }}>挨拶文: 準備中（保存後に自動生成を依頼します）</p>
            <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>ステータス: 保存前 — 保存後に「準備中（画像・参考リンク要約・挨拶文{form.bgVideoUrls.some((l) => l.trim()) ? "・参考動画" : ""}）」と表示され、全て揃うと「利用可能」になります</p>
          </div>
        </div>
      </section>

      <div className="mt-4 space-y-6">
        {/* Image base - required section center */}
        <fieldset className="space-y-3 rounded-xl p-3" style={{ border: "2px solid var(--teal)", background: "var(--surface)" }}>
          <legend className="font-display px-1 text-base font-bold">画像のベース（必須セクション）</legend>
          <p className="text-xs" style={{ color: "var(--dim)" }}>ベース画像をアップロードするかURLで渡すのが基本です。要素指定も選べますが必須ではありません。</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="画像のベースの種類">
            {([["upload", "画像指定（アップロード）"], ["url", "画像指定（URL）"], ["elements", "要素指定"], ["none", "画像なしで保存"]] as const).map(([mode, label]) => (
              <button key={mode} type="button" aria-label={label} aria-pressed={imageMode === mode} className="rounded-full px-3 py-2 text-sm font-semibold" style={{ background: imageMode === mode ? "var(--accent)" : "var(--surface)", color: imageMode === mode ? "var(--accent-ink)" : "var(--text)", border: "1px solid var(--border)" }} onClick={() => setImageMode(mode)}>{label}</button>
            ))}
          </div>
          {imageMode === "upload" && (
            <div>
              <span className="text-sm font-semibold">画像ファイル（PNG/JPG/WebP・10MBまで）</span>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <label htmlFor="c-upload" className={uploadButtonClass} style={{ background: "var(--accent)", color: "var(--accent-ink)", border: "1.5px solid var(--accent)" }}>
                  <UploadIcon />
                  画像をアップロード
                </label>
                <input id="c-upload" type="file" accept="image/png,image/jpeg,image/webp" aria-label="画像ファイルをアップロード" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; const { dataBase64, mimeType } = await fileToBase64(file); if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") { setSaveError("対応形式は PNG / JPG / WebP です。"); return; } setPendingUpload({ dataBase64, mimeType, preview: URL.createObjectURL(file) }); }} />
                <span className="text-sm" style={{ color: "var(--dim)" }}>{pendingUpload ? "画像を選択済みです" : "まだ画像が選択されていません"}</span>
              </div>
              {pendingUpload && <img src={pendingUpload.preview} alt="アップロード予定の画像プレビュー" className="mt-2 h-32 w-32 rounded-xl object-contain" style={{ background: "var(--surface-alt)" }} />}
            </div>
          )}
          {imageMode === "url" && (
            <div>
              <label htmlFor="c-imgurl" className="text-sm font-semibold">画像のURL（ベース画像）</label>
              <input id="c-imgurl" {...FIELDS.addImageByUrl.url} className={inputCls} style={inputStyle} value={imageUrl} placeholder="https://…（ベース画像のURL）" onChange={(e) => setImageUrl(e.target.value)} />
              {imageUrl.trim() && <img src={imageUrl.trim()} alt="URL指定の画像プレビュー" className="mt-2 h-32 w-32 rounded-xl object-contain" style={{ background: "var(--surface-alt)" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />}
              <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>空のまま保存すると画像なしとして扱います。</p>
            </div>
          )}
          {imageMode === "elements" && (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: "var(--dim)" }}>要素指定は下の「見た目の要素指定」で入力してください（通常表示になっています）。保存後にこの要素で画像生成を自動で依頼します。</p>
            </div>
          )}
          {imageMode === "none" && <p className="text-sm" style={{ color: "var(--dim)" }}>画像欄は「未設定」で保存し、あとから詳細画面で設定できます。この場合、画像は準備完了条件から外れます（image=none）。</p>}
        </fieldset>

        <ProfileFormFields form={form} setForm={setForm} showOptional={showOptional} onToggleOptional={() => setShowOptional(!showOptional)} elementsCollapsed={imageMode !== "elements"} hasImage={imageMode === "upload" || imageMode === "url"} />
        {nameError && <p className="text-sm" style={{ color: "var(--accent)" }}>{nameError}</p>}


        {/* Confirmation summary */}
        <section aria-label="確認" className="space-y-2 rounded-xl p-4 text-sm" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <h3 className="font-display text-base font-bold">確認</h3>
          <p>名前: {form.name || "（未入力）"} ／ 参考リンク: {form.bgLinks.filter((l) => l.trim()).length}件 ／ 参考動画: {form.bgVideoUrls.filter((l) => l.trim()).length}件 ／ 画像: {imageMode === "upload" ? (pendingUpload ? "アップロード済み" : "未選択") : imageMode === "url" ? (imageUrl ? `URL: ${imageUrl}` : "URL未入力（画像なし扱い）") : imageMode === "elements" ? "要素指定" : "画像なし"}</p>
          <p className="text-xs" style={{ color: "var(--dim)" }}>保存時に自動で積まれるリクエスト: 挨拶文（常時）{form.bgLinks.some((l) => l.trim()) ? "、参考リンク要約" : ""}{form.bgVideoUrls.some((l) => l.trim()) ? "、参考動画の文字起こし" : ""}{imageMode === "elements" ? "、画像生成" : ""}{syncChecked && charaStatus.data?.available ? "、キャラチャットへ反映" : ""}</p>
        </section>

        {/* CR-24: キャラチャットに反映する */}
        <CharaChatSyncField
          status={charaStatus.data}
          checked={syncChecked}
          onChange={(v) => setSyncOverride(v)}
        />

        {saveError && <p className="text-sm" style={{ color: "var(--accent)" }}>{saveError}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-label="保存する" className="rounded-lg px-5 py-2.5 text-sm font-bold text-white" style={{ background: "var(--accent)" }} disabled={saving} onClick={() => void save(false)}>{saving ? "保存中…" : "保存する（必須だけでも可）"}</button>
          <button type="button" aria-label="保存してすぐ切り替える" className="rounded-lg px-4 py-2 text-sm font-bold" style={{ border: "2px solid var(--accent)", color: "var(--accent)" }} disabled={saving} onClick={() => void save(true)}>保存してすぐ切り替える</button>
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--dim)" }}>保存すると、背景リンクの要約・参考動画の文字起こし・挨拶文の生成リクエストが自動で登録されます。実際の読み取りや生成はチャット側の処理です。リンクや文字起こしの読み取りは二段階が標準です：まず通常のテキスト取得で読み、読めなかったものは実ブラウザで開いて再取得します（全プロファイル共通）。リクエスト一覧に表示される案内文をチャットに貼ると処理が始まります（キャラチャットへの同期だけは自動で処理されます）。</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail / edit view
// ---------------------------------------------------------------------------

function DetailView({
  id,
  navigate,
}: {
  id: string;
  navigate: (v: View) => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["profile", id],
    queryFn: () => api.getProfile({ id }),
  });
  const profile = detail.data?.profile;
  const [form, setForm] = useState<FormState | null>(null);
  const [saveMsg, setSaveMsg] = useState("");
  const [greetingMsg, setGreetingMsg] = useState("");
  const [saveError, setSaveError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // CR-04: phrase created by the action just taken (switch or apply).
  // CR-13: `origin` records which button created the phrase so it can be
  // shown directly under that button — a phrase from 「保存して今すぐ反映」
  // renders under the save buttons (origin "save"), not at the top of the
  // detail screen; a phrase from the 切り替える button keeps its
  // original top position (origin "switch"), near that button.
  const [phrase, setPhrase] = useState<{
    text: string;
    kind: "switch" | "apply";
    origin: "save" | "switch";
  } | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [showOptionalDetail, setShowOptionalDetail] = useState(false);
  const [memoryChoice, setMemoryChoice] = useState<"keep" | "reset" | "duplicate">("keep");
  // CR-24: chara-chat auto-sync. The checkbox state follows, in order:
  // the user's explicit toggle in this session, the profile's stored
  // preference, then availability (auto-checked when a receiver app is
  // discovered in this environment).
  const charaStatus = useQuery({
    queryKey: ["chara-sync-status"],
    queryFn: () => api.getCharaChatSyncStatus({}),
  });
  const [syncOverride, setSyncOverride] = useState<boolean | null>(null);
  const syncChecked =
    syncOverride ??
    profile?.chara_chat_sync ??
    charaStatus.data?.available ??
    false;
  // CR-13: anchor for the phrase shown under the save buttons; used to
  // gently scroll it into view right after it appears.
  const savePhraseRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (profile && form === null) setForm(formFromProfile(profile));
  }, [profile, form]);

  // CR-13: after a save-created phrase appears under the save buttons,
  // nudge the view so the phrase (and its copy button) is visible without
  // the user hunting for it. `block: "nearest"` keeps this minimal when
  // it is already on screen. Runs again when the form remounts after the
  // post-save refetch (form is briefly null), when the ref re-attaches.
  useEffect(() => {
    if (!phrase || phrase.origin !== "save") return;
    const t = setTimeout(() => {
      const el = savePhraseRef.current;
      if (!el) return;
      const reduce =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
    }, 80);
    return () => clearTimeout(t);
  }, [phrase, form]);

  const genList = useQuery({
    queryKey: ["gen-requests", id],
    queryFn: () =>
      api.listGenerationRequests({ profile_id: id, only_open: false, limit: 20 }),
  });
  // CR-04: open switch requests for this profile, so their canned phrases
  // stay visible (and re-copyable) on the detail screen until closed.
  const pendingSwitches = useQuery({
    queryKey: ["pending-switches"],
    queryFn: () => api.listPendingSwitchRequests({}),
  });
  const openSwitchesForProfile = (pendingSwitches.data?.requests ?? []).filter(
    (r) => r.profile_id === id,
  );
  const openAppliesForProfile = (genList.data?.requests ?? []).filter(
    (r) =>
      r.kind === "profile_apply" &&
      (r.status === "pending" || r.status === "processing"),
  );
  const history = useQuery({
    queryKey: ["history", id],
    queryFn: () => api.listHistory({ profile_id: id }),
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    void queryClient.invalidateQueries({ queryKey: ["profile", id] });
    void queryClient.invalidateQueries({ queryKey: ["gen-requests", id] });
    void queryClient.invalidateQueries({ queryKey: ["history", id] });
    void queryClient.invalidateQueries({ queryKey: ["pending-switches"] });
    void queryClient.invalidateQueries({ queryKey: ["gen-open"] });
  };

  const saveMut = useMutation({
    mutationFn: async (applyNow: boolean) => {
      if (!form || !profile) throw new Error("フォームが準備できていません。");
      let f = form;
      if (memoryChoice === "duplicate") {
        // F-13: unify the duplicate routes — like the server-side
        // duplicateProfile, the copy must not inherit candidate_id
        // (it belongs to the original's apply flow) or the chara-chat
        // synced state (chara_chat_synced_at: the copy itself has
        // never been reflected). formToData carries both through from
        // the original, so they are explicitly reset here. The sync
        // preference itself is governed by the checkbox below.
        const data = {
          ...formToData(form, profile),
          candidate_id: null,
          chara_chat_synced_at: null,
        };
        const created = await api.createProfile({
          name: `${form.name.trim()} のコピー`,
          data,
          favorite: form.favorite,
          sync_to_chara_chat: syncChecked,
        });
        // R-4: createProfile defers the chara_chat_sync queueing to
        // the caller (it returns null now) — queue it here so a
        // duplicate made with the sync checkbox on is still reflected,
        // exactly as before. A failure leaves charaSyncQueued false
        // and does not fail the duplication.
        let charaSyncQueued = false;
        if (syncChecked) {
          try {
            await api.createGenerationRequest({
              profile_id: created.id,
              kind: "chara_chat_sync",
              payload: "{}",
            });
            charaSyncQueued = true;
          } catch {
            charaSyncQueued = false;
          }
        }
        return {
          duplicatedTo: created.id,
          linkRequeued: false,
          flavorExamplesQueued: false,
          videoQueued: false,
          charaSyncQueued,
          applyKind: null as "profile_apply" | "switch" | null,
          applyPhrase: null as string | null,
        };
      }
      if (memoryChoice === "reset") f = { ...form, avatarMemory: "" };
      const bigChange =
        form.name.trim() !== profile.name ||
        form.bgText !== profile.background.text;
      // Fields the user emptied on purpose must actually clear; everything
      // else the form did not carry keeps its stored value server-side
      // (partial update, D-02).
      const allowClear: string[] = [];
      if (memoryChoice === "reset" || (profile.avatar_memory && !f.avatarMemory))
        allowClear.push("avatar_memory");
      if (profile.background.link_summary && !f.linkSummary.trim())
        allowClear.push("link_summary");
      // The server preserves any field the payload leaves empty (D-02);
      // fields the user emptied on purpose in this form must be listed so
      // the clear actually happens.
      if (profile.summary && !f.summary.trim()) allowClear.push("summary");
      if (profile.greeting && !f.greeting) allowClear.push("greeting");
      if (profile.background.text && !f.bgText) allowClear.push("background_text");
      // CR-07: 「私の扱い」 emptied on purpose must actually clear.
      if (profile.background.user_relationship && !f.userRelationship.trim())
        allowClear.push("user_relationship");
      // CR-19: 「演じる姿・状況」 emptied on purpose must actually clear.
      if (profile.background.portrayal_focus && !f.portrayalFocus.trim())
        allowClear.push("portrayal_focus");
      if (profile.background.links.length > 0 && f.bgLinks.every((l) => !l.trim()))
        allowClear.push("links");
      // CR-17: 参考動画URLを全て消した場合は実際に消す（サーバー側の保持ルールへの明示）。
      if ((profile.background.video_urls ?? []).length > 0 && f.bgVideoUrls.every((l) => !l.trim()))
        allowClear.push("video_urls");
      if (profile.call_user_as && !f.callUserAs.trim()) allowClear.push("call_user_as");
      if (profile.speech.style && !f.speechStyle.trim()) allowClear.push("speech_style");
      // CR-06: structured speech fields the user emptied on purpose.
      if (profile.speech.structured.first_person && !f.speechFirstPerson.trim()) allowClear.push("speech_first_person");
      if (profile.speech.structured.second_person && !f.speechSecondPerson.trim()) allowClear.push("speech_second_person");
      if (profile.speech.structured.catchphrase && !f.speechCatchphrase.trim()) allowClear.push("speech_catchphrase");
      if (profile.speech.structured.memo && !f.speechMemo.trim()) allowClear.push("speech_memo");
      // CR-08: flavor traits deleted down to zero on purpose must
      // actually clear (otherwise the server preserves them, D-02 rule).
      if ((profile.flavor?.traits ?? []).length > 0 && f.flavorTraits.filter((t) => t.label.trim()).length === 0)
        allowClear.push("flavor_traits");
      // CR-10: a theme color the user changed (or returned to automatic)
      // in this form must actually apply — the server otherwise protects
      // a stored manual color from any non-manual payload.
      if (
        f.themeColor.toLowerCase() !== (profile.theme_color ?? "").toLowerCase() ||
        f.themeColorSource !== profile.theme_color_source
      )
        allowClear.push("theme_color");
      if (profile.voice.kind && !f.voiceKind.trim()) allowClear.push("voice_kind");
      if (profile.voice.speed && !f.voiceSpeed.trim()) allowClear.push("voice_speed");
      for (const { key } of ELEMENT_DEFS) {
        if (profile.image_base.elements[key] && !f.elements[key])
          allowClear.push(`elements:${key}`);
      }
      const updated = await api.updateProfile({
        id,
        name: form.name.trim(),
        data: formToData(f, profile),
        favorite: form.favorite,
        change_label: bigChange ? "名前・設定の変更" : "編集",
        allow_clear: allowClear,
        apply_now: applyNow,
        sync_to_chara_chat: syncChecked,
        // F-3: the revision this form loaded — a stale form cannot
        // roll back a memory a generation write-back repaired since.
        avatar_memory_revision: form.avatarMemoryRevision,
      });
      return {
        duplicatedTo: null as string | null,
        linkRequeued: updated.link_summary_requeued,
        // CR-12: a flavor_examples request was queued/refreshed by this save.
        flavorExamplesQueued: !!updated.flavor_examples_request_id,
        // CR-17: a video_transcript request was queued/refreshed by this save.
        videoQueued: !!updated.video_transcript_request_id,
        // CR-24: a chara_chat_sync request was queued/refreshed by this save.
        charaSyncQueued: !!updated.chara_chat_sync_request_id,
        applyKind: updated.apply_kind,
        applyPhrase: updated.apply_phrase,
      };
    },
    onSuccess: (r) => {
      setSaveError("");
      if (r.duplicatedTo) {
        setSaveMsg("複製して新しいプロファイルとして保存しました。");
        invalidateAll();
        navigate({ kind: "detail", id: r.duplicatedTo });
        return;
      }
      // CR-04: show the new request's canned phrase right away.
      // CR-13: it renders directly under the save buttons (origin "save").
      if (r.applyPhrase) {
        setPhrase({
          text: r.applyPhrase,
          kind: r.applyKind === "profile_apply" ? "apply" : "switch",
          origin: "save",
        });
      }
      const baseMsg =
        r.applyKind === "profile_apply"
          ? "保存して、今すぐ反映リクエストを作成しました（反映待ち）。保存ボタンの直下に表示された定型文をチャットに貼って送信すると、口調・名前・呼び方が即時適用され、画像が変わっていれば候補生成→選択→セットまで進みます。"
          : r.applyKind === "switch"
            ? "保存して、切替リクエストを作成しました（反映待ち）。保存ボタンの直下に表示された定型文をチャットに貼って送信すると、このアバターに切り替わります。"
            : profile?.is_active
              ? "保存のみしました（次回切替時に反映）。今すぐ反映したい場合は「保存して今すぐ反映」を押してください。"
              : "保存のみしました（次回切替時に反映）。";
      setSaveMsg(
        (r.linkRequeued
          ? `${baseMsg} 参考リンクが追加・変更されたため、要約の再生成を自動で依頼しました（準備中：参考リンク要約）。`
          : baseMsg) +
          (r.flavorExamplesQueued
            ? " 「例文を自動作成」がオンで例文が未入力のフレーバー項目について、例文の自動作成を依頼しました（自動作成待ち）。"
            : "") +
          (r.videoQueued
            ? " 未処理の参考動画について、文字起こしの取得を依頼しました（準備中：参考動画）。"
            : "") +
          (r.charaSyncQueued
            ? " キャラチャットへの反映リクエストを作成しました（連携先へ自動で取り込まれます）。"
            : ""),
      );
      setForm(null);
      invalidateAll();
    },
    onError: (e) =>
      setSaveError(e instanceof Error ? e.message : "保存に失敗しました。"),
  });

  const switchMut = useMutation({
    mutationFn: async () => await api.requestSwitch({ profile_id: id }),
    onSuccess: (r) => {
      setPhrase({ text: r.phrase, kind: "switch", origin: "switch" });
      invalidateAll();
    },
    onError: (e) =>
      setSaveError(e instanceof Error ? e.message : "切替リクエストに失敗しました。"),
  });

  const dupMut = useMutation({
    mutationFn: async () => await api.duplicateProfile({ id }),
    onSuccess: (r) => {
      invalidateAll();
      navigate({ kind: "detail", id: r.id });
    },
    onError: (e) =>
      setSaveError(e instanceof Error ? e.message : "複製に失敗しました。"),
  });

  const delMut = useMutation({
    mutationFn: async () => await api.deleteProfile({ id }),
    onSuccess: () => {
      invalidateAll();
      navigate({ kind: "list" });
    },
    onError: (e) =>
      setSaveError(e instanceof Error ? e.message : "削除に失敗しました。"),
  });

  const genMut = useMutation({
    mutationFn: async (args: { kind: "image_generation" | "link_summary" | "trial_conversation" | "video_transcript" | "chara_chat_sync"; payload: string }) =>
      await api.createGenerationRequest({ profile_id: id, kind: args.kind, payload: args.payload }),
    onSuccess: () => invalidateAll(),
    onError: (e) =>
      setSaveError(e instanceof Error ? e.message : "リクエストの作成に失敗しました。"),
  });

  // Greeting re-creation: same trial_conversation flow as at creation
  // time, with the note reworded for a re-creation. On success the
  // request joins the normal generation-request queue (the greeting
  // turns pending server-side and is replaced when the chat side
  // completes the request).
  const greetingRegenMut = useMutation({
    mutationFn: async (payload: string) =>
      await api.createGenerationRequest({
        profile_id: id,
        kind: "trial_conversation",
        payload,
      }),
    onSuccess: () => {
      setGreetingMsg(
        "挨拶文の再作成リクエストを作成しました。チャット側で処理されると、挨拶文が新しいものに置き換わります。",
      );
      invalidateAll();
    },
    onError: (e) =>
      setSaveError(
        e instanceof Error ? e.message : "挨拶文の再作成リクエストの作成に失敗しました。",
      ),
  });

  // A-09 alternative: give up on the image and use the profile without one.
  const imageNoneMut = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("プロファイルが読み込めていません。");
      for (const img of profile.images) {
        await api.removeImage({ profile_id: id, image_id: img.id });
      }
      const base = formFromProfile(profile);
      const data = formToData({ ...base, imageBaseType: "none", imageRef: "" }, profile);
      data.images = [];
      data.image_base = { type: "none", image_ref: null, elements: data.image_base.elements };
      return await api.updateProfile({
        id,
        name: profile.name,
        data,
        favorite: profile.favorite,
        change_label: "画像なしに変更",
        allow_clear: ["images", "image_ref"],
      });
    },
    onSuccess: () => {
      setForm(null);
      setSaveMsg("画像なしで利用する設定にしました（画像は準備条件から外れます）。");
      invalidateAll();
    },
    onError: (e) =>
      setSaveError(e instanceof Error ? e.message : "画像なしへの変更に失敗しました。"),
  });

  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      const { dataBase64, mimeType } = await fileToBase64(file);
      if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp")
        throw new Error("対応形式は PNG / JPG / WebP です。");
      // CR-10: extract the new image's dominant color; the server makes
      // it the theme color unless the user set one manually.
      const objUrl = URL.createObjectURL(file);
      const candidate = await extractDominantColor(objUrl);
      URL.revokeObjectURL(objUrl);
      return await api.uploadImage({
        profile_id: id,
        data_base64: dataBase64,
        mime_type: mimeType,
        make_primary: true,
        theme_color_candidate: candidate,
      });
    },
    onSuccess: () => {
      setForm(null);
      invalidateAll();
    },
    onError: (e) =>
      setSaveError(e instanceof Error ? e.message : "画像の登録に失敗しました。"),
  });

  const addUrlMut = useMutation({
    mutationFn: async () => {
      // CR-10: best-effort dominant color for the URL image (null when
      // the image is not readable from here, e.g. CORS — the server then
      // keeps the current auto/default color).
      const candidate = await extractDominantColor(urlInput.trim());
      return await api.addImageByUrl({
        profile_id: id,
        url: urlInput.trim(),
        make_primary: true,
        theme_color_candidate: candidate,
      });
    },
    onSuccess: () => {
      setUrlInput("");
      setForm(null);
      invalidateAll();
    },
    onError: (e) =>
      setSaveError(e instanceof Error ? e.message : "URLの登録に失敗しました。"),
  });

  const primaryMut = useMutation({
    mutationFn: async (imageId: string) => {
      // CR-10: switching the representative image re-acquires the theme
      // color from the new primary (server skips this for manual colors).
      const img = profile?.images.find((i) => i.id === imageId);
      const imgSrc = img ? (img.url ?? (img.source === "url" ? img.file : null)) : null;
      const candidate = imgSrc ? await extractDominantColor(imgSrc) : null;
      return await api.setPrimaryImage({
        profile_id: id,
        image_id: imageId,
        theme_color_candidate: candidate,
      });
    },
    onSuccess: () => {
      setForm(null);
      invalidateAll();
    },
  });
  const removeImgMut = useMutation({
    mutationFn: async (imageId: string) =>
      await api.removeImage({ profile_id: id, image_id: imageId }),
    // CR-28: reset the edit form like the other image mutations do —
    // the form carries image_base.image_ref as load-time state, so
    // keeping the pre-deletion form would re-submit the deleted image's
    // reference on the next save.
    onSuccess: () => {
      setForm(null);
      invalidateAll();
    },
  });

  const restoreMut = useMutation({
    mutationFn: async (historyId: number) =>
      await api.restoreHistory({ profile_id: id, history_id: historyId }),
    onSuccess: () => {
      setForm(null);
      invalidateAll();
    },
    onError: (e) =>
      setSaveError(e instanceof Error ? e.message : "復元に失敗しました。"),
  });

  async function exportJson(includePersonal: boolean) {
    try {
      const r = await api.exportProfile({ id, include_personal: includePersonal });
      const blob = new Blob([r.json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "書き出しに失敗しました。");
    }
  }

  if (detail.isPending) return <p className="mt-6 text-sm">読み込み中…</p>;
  if (detail.error || !profile)
    return (
      <p className="mt-6 text-sm" style={{ color: "var(--accent)" }}>
        プロファイルが見つかりませんでした。
      </p>
    );

  const trialResults = (genList.data?.requests ?? []).filter(
    (r) => r.kind === "trial_conversation",
  );
  // An unfinished trial_conversation (or a greeting still marked
  // pending) means a (re-)creation is already queued — block duplicates
  // in the UI as well (the server upserts too).
  const greetingRequestOpen =
    profile.preparation.greeting === "pending" ||
    trialResults.some(
      (r) => r.status === "pending" || r.status === "processing",
    );
  const inputCls = "w-full rounded-lg px-3 py-2 text-sm";
  const inputStyle = { background: "var(--surface)", border: "1px solid var(--border)" };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="一覧に戻る"
          className="rounded-lg px-3 py-2 text-sm"
          style={{ border: "1px solid var(--border)" }}
          onClick={() => navigate({ kind: "list" })}
        >
          ← 一覧
        </button>
        <h2 className="font-display min-w-0 flex-1 text-xl font-bold break-all">
          {profile.name}
        </h2>
        {profile.is_active && (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
            style={{ background: "var(--teal)" }}
          >
            ● 使用中
          </span>
        )}
        <PreparationBadge profile={profile} showDetail />
        <PendingApplyBadge profile={profile} />
        <PortrayalFailedBadge profile={profile} />
      </div>

      {(profile.pending_apply_count > 0 || profile.pending_switch_count > 0) && (
        <div
          className="mt-3 rounded-lg p-3"
          style={{ background: "var(--surface-alt)", border: "1.5px solid var(--gold)" }}
          role="status"
        >
          <p className="text-sm font-semibold">
            反映待ちのリクエストがあります
            {profile.pending_apply_count > 0 &&
              `（プロファイル反映 ${profile.pending_apply_count}件）`}
            {profile.pending_switch_count > 0 &&
              `（切替 ${profile.pending_switch_count}件）`}
            。下の定型文をチャットに貼って送信すると適用されます。完了・失敗で閉じられると、この表示は消えます。
          </p>
          {/* CR-04: open requests' phrases stay here for re-copying. */}
          {openSwitchesForProfile.map((r) => (
            <div key={r.id}>
              <PhraseBox phrase={r.phrase} kind="switch" />
              <div className="mt-1 flex justify-end">
                <RequestDeleteButton
                  ariaSubject={`「${r.profile_name}」への切替リクエスト`}
                  deleteFn={async () =>
                    await api.deleteSwitchRequest({ request_id: r.id })
                  }
                />
              </div>
            </div>
          ))}
          {openAppliesForProfile.map(
            (r) =>
              r.phrase && (
                <div key={r.id}>
                  <PhraseBox phrase={r.phrase} kind="apply" />
                  <div className="mt-1 flex justify-end">
                    <RequestDeleteButton
                      ariaSubject={`「${r.profile_name ?? profile.name}」のプロファイル反映リクエスト`}
                      deleteFn={async () =>
                        await api.deleteGenerationRequest({ request_id: r.id })
                      }
                    />
                  </div>
                </div>
              ),
          )}
        </div>
      )}

      {/* Preview */}
      <section aria-label="プレビュー" className="mt-4 rounded-2xl p-4" style={{ background: `color-mix(in srgb, ${profile.theme_color || DEFAULT_THEME_COLOR} 4%, var(--surface))`, border: `2px solid ${profile.theme_color || DEFAULT_THEME_COLOR}` }}>
        <h3 className="font-display text-lg font-bold">プレビュー</h3>
        <div className="mt-3 flex flex-col gap-4 sm:flex-row">
          <div className="shrink-0">
            <AvatarTile profile={profile} size={128} />
            <p className="mt-1 text-center text-xs" style={{ color: "var(--dim)" }}>{profile.images.length === 0 && !profile.image_base.image_ref ? "画像未設定" : profile.image_base.image_ref && profile.images.length === 0 ? `参照: ${profile.image_base.image_ref}` : "代表画像"}</p>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">挨拶文</p>
            {profile.preparation.greeting === "failed" ? (
              <p className="mt-1 rounded-lg p-3 text-sm" style={{ background: "var(--surface-alt)", color: "var(--accent)" }}>
                失敗（理由: {profile.preparation_errors.greeting ?? "理由不明"}）。下の「再試行」からもう一度依頼できます。
                {profile.greeting && <span className="block mt-1" style={{ color: "var(--text)" }}>前回の挨拶文: 「{profile.greeting}」</span>}
              </p>
            ) : profile.greeting ? (
              <p className="mt-1 rounded-lg p-3 text-sm whitespace-pre-wrap" style={{ background: "var(--surface-alt)" }}>「{profile.greeting}」</p>
            ) : profile.preparation.greeting === "pending" ? (
              <p className="mt-1 rounded-lg p-3 text-sm" style={{ background: "var(--surface-alt)", color: "var(--dim)" }}>準備中（挨拶文を生成しています。完了するとここに表示されます）</p>
            ) : (
              <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>未設定</p>
            )}
            <div className="mt-2">
              <button
                type="button"
                aria-label="挨拶文を再作成する"
                className="rounded-lg px-3 py-2 text-sm font-semibold"
                style={{ border: "1px solid var(--border)" }}
                disabled={greetingRequestOpen || greetingRegenMut.isPending}
                onClick={() => {
                  setGreetingMsg("");
                  greetingRegenMut.mutate(
                    JSON.stringify({
                      name: profile.name,
                      speech_style: profile.speech.style,
                      tuning: profile.speech.tuning,
                      call_user_as: profile.call_user_as,
                      speech_structured: {
                        first_person: profile.speech.structured.first_person,
                        second_person: profile.speech.structured.second_person,
                        call_user_as: profile.call_user_as,
                        catchphrase: profile.speech.structured.catchphrase,
                        memo: profile.speech.structured.memo,
                      },
                      speech_sources: profile.speech.sources,
                      background: profile.background.text,
                      user_relationship: profile.background.user_relationship ?? null,
                      flavor_level: profile.flavor?.level ?? 3,
                      flavor_traits: (profile.flavor?.traits ?? []).map((t) => ({
                        ...t,
                        frequency: t.frequency ?? null,
                        effective_frequency: effectiveFlavorFrequency(t, profile.flavor?.level ?? 3),
                      })),
                      links: profile.background.links,
                      note: "挨拶文（greeting）を再作成してください。短い自己紹介・挨拶を生成し、結果は {greeting: string} で返してください。口調の構造化欄のうち手動指定（speech_sources が manual）の欄は変更せず、未設定・自動の欄は背景から推定して result の speech に含めて返してください。user_relationship（私の扱い）が指定されている場合は、その関係性に倣った接し方で挨拶文を作ってください。フレーバー項目を推定できる場合は result の flavor_traits に含めて返してください（手動指定の項目は変更しないでください）。各フレーバー項目は effective_frequency（実効頻度）に従ってください（0の項目は出さない）。",
                    }),
                  );
                }}
              >
                {greetingRegenMut.isPending
                  ? "作成中…"
                  : greetingRequestOpen
                    ? "再作成リクエスト済み（処理待ち）"
                    : "挨拶文を再作成"}
              </button>
              {greetingMsg && (
                <p className="mt-2 rounded-lg p-3 text-sm" style={{ background: "var(--surface-alt)" }} role="status">
                  {greetingMsg}
                </p>
              )}
            </div>
            <p className="mt-3 text-sm font-semibold">準備ステータス</p>
            <PreparationChecklist profile={profile} />
            <p className="mt-3 text-sm font-semibold">私の扱い</p>
            {profile.background.user_relationship ? (
              <p className="mt-1 rounded-lg p-3 text-sm whitespace-pre-wrap" style={{ background: "var(--surface-alt)" }}>{profile.background.user_relationship}</p>
            ) : (
              <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>未指定（背景や呼び方から自然に推定されます）</p>
            )}
            <p className="mt-3 text-sm font-semibold">演じる姿・状況</p>
            {profile.background.portrayal_focus ? (
              <>
                <p className="mt-1 rounded-lg p-3 text-sm whitespace-pre-wrap" style={{ background: "var(--surface-alt)", border: "1.5px solid var(--gold)" }}>{profile.background.portrayal_focus}</p>
                {profile.background.portrayal_focus_status === "failed" && (
                  <div className="mt-2 rounded-lg p-3 text-sm" style={{ background: "var(--surface-alt)", border: "1.5px solid var(--accent)" }} role="status">
                    <PortrayalFailedBadge profile={profile} />
                    <p className="mt-2">
                      理由: {profile.background.portrayal_focus_failure_reason ?? "指定の姿・状況に当たる資料がありませんでした"}
                    </p>
                    {portrayalCheckedLabels(profile).length > 0 && (
                      <p className="mt-1" style={{ color: "var(--dim)" }}>
                        判定に使った資料: {portrayalCheckedLabels(profile).join("・")}
                      </p>
                    )}
                    <p className="mt-1" style={{ color: "var(--dim)" }}>
                      この指定は現在バイアスとして効いておらず、プロファイルは資料全体から通常どおり作られ、全体の姿で応答します（プロファイル自体は利用できます）。資料を追加・変更して再判定で当たる資料が見つかれば、指定は自動で再び有効になります。
                    </p>
                  </div>
                )}
                {profile.background.portrayal_focus_status === "ok" && (
                  <p className="mt-1 text-sm" style={{ color: "var(--teal)" }}>
                    ✓ 指定に当たる資料が見つかっています（バイアス有効
                    {portrayalCheckedLabels(profile).length > 0 && `／判定に使った資料: ${portrayalCheckedLabels(profile).join("・")}`}
                    ）
                  </p>
                )}
              </>
            ) : (
              <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>未指定（バイアスなし。通常どおり全体から作られ、全体の姿で応答します）</p>
            )}
            <p className="mt-3 text-sm font-semibold">参考動画（文字起こし）</p>
            {(profile.background.video_urls ?? []).length === 0 ? (
              <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>未設定（参考動画URLは下の編集画面で、参考リンクとは別に追加できます）</p>
            ) : (
              <div className="mt-1">
                <ul className="space-y-1 text-sm">
                  {(profile.background.video_urls ?? []).map((u) => (
                    <li key={u} className="break-all">
                      <a href={u} target="_blank" rel="noreferrer" className="underline" style={{ color: "var(--teal)" }}>{u}</a>
                      {isYouTubePlaylistUrl(u) && (
                        <span className="ml-2 inline-block rounded-full px-2 py-0.5 align-middle text-xs font-bold" style={{ border: "1.5px solid var(--teal)", color: "var(--teal)" }}>再生リスト（各動画を文字起こし）</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-sm">
                  処理状態:{" "}
                  {profile.preparation.video === "done"
                    ? "完了（文字起こしを取得済み）"
                    : profile.preparation.video === "pending"
                      ? "処理中（文字起こしを取得しています）"
                      : profile.preparation.video === "failed"
                        ? "失敗"
                        : "対象外"}
                  {profile.preparation.video === "failed" && (
                    <span style={{ color: "var(--accent)" }}>（理由: {profile.preparation_errors.video ?? "理由不明"}）</span>
                  )}
                </p>
                {profile.background.video_notes && (
                  <>
                    <p className="mt-2 text-sm font-semibold">台詞から読み取れた口調の特徴</p>
                    <p className="mt-1 rounded-lg p-3 text-sm whitespace-pre-wrap" style={{ background: "var(--surface-alt)" }}>{profile.background.video_notes}</p>
                  </>
                )}
                {(profile.background.unreadable_videos ?? []).length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm font-semibold" style={{ color: "var(--accent)" }}>文字起こしを取得できなかった動画</p>
                    <ul className="mt-1 list-disc pl-5 text-sm space-y-1" style={{ color: "var(--accent)" }}>
                      {(profile.background.unreadable_videos ?? []).map((u) => (
                        <li key={u} className="break-all">{u}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <p className="mt-3 text-sm font-semibold">口調の内訳（手動指定が自動生成より優先されます）</p>
            <ul className="mt-1 space-y-1 text-sm">
              {(
                [
                  { label: "一人称", value: profile.speech.structured.first_person, source: profile.speech.sources.first_person },
                  { label: "二人称", value: profile.speech.structured.second_person, source: profile.speech.sources.second_person },
                  { label: "私の呼び方", value: profile.call_user_as, source: profile.speech.sources.call_user_as },
                  { label: "口癖", value: profile.speech.structured.catchphrase, source: profile.speech.sources.catchphrase },
                  { label: "語尾・口調メモ", value: profile.speech.structured.memo, source: profile.speech.sources.memo },
                  { label: "スタイル文", value: profile.speech.style, source: profile.speech.sources.style },
                ] as const
              ).map((row) => (
                <li key={row.label} className="flex flex-wrap items-center gap-2">
                  <span style={{ color: "var(--dim)" }}>{row.label}:</span>
                  <span className="break-words">{row.value ?? "未設定"}</span>
                  <SpeechSourceBadge source={row.source} hasValue={!!row.value} />
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm font-semibold">フレーバー（キャラクターらしさ）</p>
            <p className="mt-1 text-sm">
              量（一括・既定）: {profile.flavor?.level ?? 3}/5 — {FLAVOR_LEVEL_DESCRIPTIONS[profile.flavor?.level ?? 3] ?? ""}
            </p>
            {(() => {
              const globalLv = profile.flavor?.level ?? 3;
              const enabledTraits = (profile.flavor?.traits ?? []).filter((t) => t.enabled);
              if (enabledTraits.length === 0) {
                return (
                  <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
                    有効なフレーバー項目は未設定です（背景リンクの要約や挨拶文の生成で自動で入ります）
                  </p>
                );
              }
              return (
                <ul className="mt-1 space-y-2 text-sm">
                  {enabledTraits.map((t) => {
                    const eff = effectiveFlavorFrequency(t, globalLv);
                    const differs = flavorFrequencyIsCustom(t, globalLv);
                    return (
                    <li key={t.id} className="rounded-lg p-2" style={{ background: differs ? "color-mix(in srgb, var(--gold) 8%, var(--surface-alt))" : "var(--surface-alt)", border: differs ? "1.5px solid var(--gold)" : "1px solid transparent" }}>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{t.label}</span>
                        <SpeechSourceBadge source={t.source} hasValue />
                        <FlavorEffectiveBadge trait={t} globalLevel={globalLv} />
                        {eff === 0 && <span className="text-xs font-bold" style={{ color: "var(--accent)" }}>この項目は出ません（実効0）</span>}
                        {traitNeedsAutoExamples(t) && <AutoExamplesPendingBadge />}
                        {t.scenes.length > 0 && (
                          <span className="text-xs" style={{ color: "var(--dim)" }}>
                            場面: {t.scenes.join("・")}
                          </span>
                        )}
                      </span>
                      {t.examples.length > 0 && (
                        <span className="mt-0.5 block">
                          フレーバーの例: 「{t.examples[0]}」
                          {t.examples.length > 1 && (
                            <span style={{ color: "var(--dim)" }}>（ほか{t.examples.length - 1}件）</span>
                          )}
                        </span>
                      )}
                      {traitNeedsAutoExamples(t) && (
                        <span className="mt-0.5 block text-xs" style={{ color: "var(--dim)" }}>
                          例文は自動作成待ちです（保存時にチャット側へ依頼済み、または次回保存で依頼されます）
                        </span>
                      )}
                    </li>
                    );
                  })}
                </ul>
              );
            })()}
            {(profile.flavor?.traits ?? []).some((t) => !t.enabled) && (
              <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>
                無効の項目が{(profile.flavor?.traits ?? []).filter((t) => !t.enabled).length}件あります（チャット側へは渡りません）。編集画面で有効に戻せます。
              </p>
            )}
            <p className="mt-3 text-sm font-semibold">テーマカラー</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className="inline-block h-5 w-5 rounded"
                style={{
                  background: profile.theme_color || DEFAULT_THEME_COLOR,
                  border: "1px solid var(--border)",
                }}
              />
              {profile.theme_color || DEFAULT_THEME_COLOR}
              <ThemeSourceBadge source={profile.theme_color_source ?? "default"} />
              <span className="text-xs" style={{ color: "var(--dim)" }}>
                一覧・フォーカスのカードはこの色で彩られます。下の編集画面で変更できます（手動指定は画像を差し替えても上書きされません）。
              </span>
            </p>
            {profile.preparation.status === "needs_attention" && (
              <div className="mt-3 rounded-lg p-3" style={{ border: "1.5px solid var(--accent)" }} aria-label="失敗した準備項目への対応">
                <p className="text-sm font-bold" style={{ color: "var(--accent)" }}>失敗した項目への対応</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {profile.preparation.image === "failed" && (
                    <button type="button" aria-label="画像生成を再試行する" className="rounded-lg px-3 py-2 text-sm font-semibold text-white" style={{ background: "var(--accent)" }} disabled={genMut.isPending} onClick={() => genMut.mutate({ kind: "image_generation", payload: JSON.stringify({ name: profile.name, elements: profile.image_base.elements, note: "失敗した画像生成の再試行" }) })}>
                      画像生成を再試行
                    </button>
                  )}
                  {profile.preparation.link_summary === "failed" && (
                    <button type="button" aria-label="参考リンク要約を再試行する" className="rounded-lg px-3 py-2 text-sm font-semibold text-white" style={{ background: "var(--accent)" }} disabled={genMut.isPending} onClick={() => genMut.mutate({ kind: "link_summary", payload: JSON.stringify({ links: profile.background.links }) })}>
                      参考リンク要約を再試行
                    </button>
                  )}
                  {profile.preparation.greeting === "failed" && (
                    <button type="button" aria-label="挨拶文の生成を再試行する" className="rounded-lg px-3 py-2 text-sm font-semibold text-white" style={{ background: "var(--accent)" }} disabled={genMut.isPending} onClick={() => genMut.mutate({ kind: "trial_conversation", payload: JSON.stringify({ name: profile.name, speech_style: profile.speech.style, tuning: profile.speech.tuning, call_user_as: profile.call_user_as, background: profile.background.text, user_relationship: profile.background.user_relationship ?? null, video_notes: profile.background.video_notes ?? null, note: "失敗した挨拶文生成の再試行" }) })}>
                      挨拶文の生成を再試行
                    </button>
                  )}
                  {profile.preparation.video === "failed" && (
                    <button type="button" aria-label="参考動画の文字起こしを再試行する" className="rounded-lg px-3 py-2 text-sm font-semibold text-white" style={{ background: "var(--accent)" }} disabled={genMut.isPending} onClick={() => genMut.mutate({ kind: "video_transcript", payload: JSON.stringify({ video_urls: profile.background.video_urls ?? [] }) })}>
                      参考動画の文字起こしを再試行
                    </button>
                  )}
                </div>
                {profile.preparation.image === "failed" && (
                  <div className="mt-3">
                    <p className="text-sm font-semibold">画像生成がうまくいかない場合の代替手段（A-09）</p>
                    <ul className="mt-1 list-disc pl-5 text-sm space-y-1">
                      <li>要素指定で作り直す: 下の「要素指定で再生成を依頼」から、要素を変えてもう一度生成を依頼できます（変えていない要素は保たれます）。</li>
                      <li>別の画像を使う: 下の「アバター画像」から、手持ちの画像をアップロードするか、画像URLを登録できます。登録すると失敗状態は解除されます。</li>
                      <li>画像なしにする: 画像なしでもプロファイルは利用できます。</li>
                    </ul>
                    <button type="button" aria-label="画像なしで利用する" className="mt-2 rounded-lg px-3 py-2 text-sm font-semibold" style={{ border: "1px solid var(--border)" }} disabled={imageNoneMut.isPending} onClick={() => imageNoneMut.mutate()}>
                      {imageNoneMut.isPending ? "変更中…" : "画像なしで利用する"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <p className="mt-2 text-xs" style={{ color: "var(--dim)" }}>
        作成元:{" "}
        {profile.origin.type === "imported"
          ? "既存から取り込み"
          : profile.origin.type === "auto_saved"
            ? "別チャットから自動保存"
            : "アプリで作成"}
        {profile.origin.chat_link ? `（${profile.origin.chat_link}）` : ""} ／ 作成:{" "}
        {fmtDate(profile.created_at)} ／ 更新: {fmtDate(profile.updated_at)} ／ 最終使用:{" "}
        {fmtDate(profile.last_used_at)} ／ 形式: avatar-profile v1.0
      </p>

      {/* CR-13: only a switch-button phrase stays here (near its button).
          A save-created phrase renders under the save buttons instead —
          see the edit form below. The pending banner above remains the
          re-copy path for every open request. */}
      {phrase && phrase.origin === "switch" && (
        <PhraseBox phrase={phrase.text} kind={phrase.kind} />
      )}
      {saveMsg && (
        <p className="mt-2 rounded-lg p-3 text-sm" style={{ background: "var(--surface-alt)" }}>
          {saveMsg}
        </p>
      )}
      {saveError && (
        <p className="mt-2 text-sm" style={{ color: "var(--accent)" }}>
          {saveError}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!profile.is_active && (
          <button
            type="button"
            aria-label={`${profile.name}に切り替える`}
            className="rounded-lg px-4 py-2 text-sm font-bold text-white"
            style={{ background: "var(--accent)" }}
            disabled={switchMut.isPending}
            onClick={() => switchMut.mutate()}
          >
            切り替える
          </button>
        )}
        <button
          type="button"
          aria-label="プロファイルを複製"
          className="rounded-lg px-3 py-2 text-sm font-semibold"
          style={{ border: "1px solid var(--border)" }}
          disabled={dupMut.isPending}
          onClick={() => dupMut.mutate()}
        >
          複製
        </button>
        {!profile.is_default &&
          (confirmDelete ? (
            <>
              <span className="flex items-center text-sm" style={{ color: "var(--accent)" }}>
                本当に削除しますか？（30日間はゴミ箱から復元でき、その後は自動で完全削除されます。キャラチャットに反映済みのキャラクターは、そちらでは消えません）
              </span>
              <button
                type="button"
                aria-label="削除を確定する"
                className="rounded-lg px-3 py-2 text-sm font-bold text-white"
                style={{ background: "var(--accent)" }}
                disabled={delMut.isPending}
                onClick={() => delMut.mutate()}
              >
                削除する
              </button>
              <button
                type="button"
                aria-label="削除をやめる"
                className="rounded-lg px-3 py-2 text-sm"
                style={{ border: "1px solid var(--border)" }}
                onClick={() => setConfirmDelete(false)}
              >
                やめる
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label="プロファイルを削除"
              className="rounded-lg px-3 py-2 text-sm font-semibold"
              style={{ border: "1px solid var(--accent)", color: "var(--accent)" }}
              onClick={() => setConfirmDelete(true)}
            >
              削除
            </button>
          ))}
      </div>
      <p className="mt-2 text-xs" style={{ color: "var(--dim)" }}>保存すると、背景リンクの要約・参考動画の文字起こし・挨拶文の生成リクエストが自動で登録されます。実際の読み取りや生成はチャット側の処理です。リンクや文字起こしの読み取りは二段階が標準です：まず通常のテキスト取得で読み、読めなかったものは実ブラウザで開いて再取得します（全プロファイル共通）。リクエスト一覧に表示される案内文をチャットに貼ると処理が始まります（キャラチャットへの同期だけは自動で処理されます）。</p>

      {/* Images */}
      <section aria-label="アバター画像" className="mt-6">
        <h3 className="font-display text-lg font-bold">アバター画像</h3>
        {profile.images.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
            画像は未設定です。
            {profile.image_base.image_ref && (
              <>
                {" "}
                参照: {profile.image_base.image_ref}（実ファイルはチャット側で保持）
              </>
            )}
          </p>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {profile.images.map((img) => {
              const src = img.url ?? (img.source === "url" ? img.file : null);
              return (
                <figure
                  key={img.id}
                  className="rounded-xl p-2"
                  style={{
                    background: "var(--surface)",
                    border: img.is_primary
                      ? "2px solid var(--teal)"
                      : "1px solid var(--border)",
                  }}
                >
                  {src ? (
                    <img
                      src={src}
                      alt={`${profile.name}の画像`}
                      className="h-28 w-full rounded-lg object-cover"
                    />
                  ) : (
                    <div
                      className="flex h-28 w-full items-center justify-center rounded-lg text-xs"
                      style={{ background: "var(--surface-alt)", color: "var(--dim)" }}
                    >
                      {img.file}
                    </div>
                  )}
                  <figcaption className="mt-1 text-xs" style={{ color: "var(--dim)" }}>
                    {img.is_primary ? "代表画像" : img.source}
                  </figcaption>
                  <div className="mt-1 flex gap-1">
                    {!img.is_primary && (
                      <button
                        type="button"
                        aria-label="この画像を代表画像にする"
                        className="rounded-lg px-2 py-1 text-xs font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
                        style={{ border: "1.5px solid var(--border)", background: "var(--surface-alt)" }}
                        onClick={() => primaryMut.mutate(img.id)}
                      >
                        代表にする
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="この画像を削除する"
                      className="rounded-lg px-2 py-1 text-xs font-bold shadow-sm transition hover:opacity-90 active:scale-[0.98]"
                      style={{ border: "1.5px solid var(--accent)", color: "var(--accent)", background: "var(--surface)" }}
                      onClick={() => removeImgMut.mutate(img.id)}
                    >
                      削除
                    </button>
                  </div>
                </figure>
              );
            })}
          </div>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <span className="text-sm font-semibold">
              画像を追加（アップロード、PNG/JPG/WebP・10MBまで）
            </span>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label htmlFor="d-upload" className={uploadButtonClass} style={{ background: "var(--accent)", color: "var(--accent-ink)", border: "1.5px solid var(--accent)" }}>
                <UploadIcon />
                画像をアップロード
              </label>
              <input
                id="d-upload"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="画像ファイルをアップロードして追加"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) uploadMut.mutate(file);
                }}
              />
              {uploadMut.isPending && <span className="text-sm" style={{ color: "var(--dim)" }}>アップロード中…</span>}
            </div>
          </div>
          <div>
            <label htmlFor="d-imgurl" className="text-sm font-semibold">
              画像を追加（URL）
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="d-imgurl"
                {...FIELDS.addImageByUrl.url}
                className={inputCls}
                style={inputStyle}
                value={urlInput}
                placeholder="https://…"
                onChange={(e) => setUrlInput(e.target.value)}
              />
              <button
                type="button"
                aria-label="URLの画像を追加"
                className="shrink-0 rounded-lg px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
                style={{ background: "var(--accent)", border: "1.5px solid var(--accent)" }}
                disabled={!urlInput.trim() || addUrlMut.isPending}
                onClick={() => addUrlMut.mutate()}
              >
                ＋ URLで追加
              </button>
            </div>
          </div>
        </div>
        <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
          {IMAGE_NOTICE}
        </p>
      </section>

      {/* Edit form */}
      {form && (
        <section aria-label="プロファイル編集" className="mt-6">
          <h3 className="font-display text-lg font-bold">設定の編集</h3>
          <div className="mt-3">
            <ProfileFormFields form={form} setForm={setForm} showOptional={showOptionalDetail} onToggleOptional={() => setShowOptionalDetail(!showOptionalDetail)} elementsCollapsed={profile.image_base.type !== "elements"} hasImage={profile.image_base.type === "image" || profile.images.length > 0} />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              aria-label="参考リンクの要約を依頼"
              className="rounded-lg px-3 py-2 text-sm font-semibold"
              style={{ border: "1px solid var(--border)" }}
              disabled={genMut.isPending || form.bgLinks.filter((l) => l.trim()).length === 0}
              onClick={() =>
                genMut.mutate({
                  kind: "link_summary",
                  payload: JSON.stringify({
                    links: form.bgLinks.map((l) => l.trim()).filter(Boolean),
                  }),
                })
              }
            >
              参考リンクの要約を依頼
            </button>
            <button
              type="button"
              aria-label="要素指定で画像の再生成を依頼"
              className="rounded-lg px-3 py-2 text-sm font-semibold"
              style={{ border: "1px solid var(--border)" }}
              disabled={genMut.isPending}
              onClick={() =>
                genMut.mutate({
                  kind: "image_generation",
                  payload: JSON.stringify({
                    name: form.name,
                    elements: form.elements,
                    note: "要素指定の一部変更を含む再生成。変えていない要素は保つこと",
                  }),
                })
              }
            >
              要素指定で再生成を依頼
            </button>
            <button
              type="button"
              aria-label="参考動画の文字起こしを依頼"
              className="rounded-lg px-3 py-2 text-sm font-semibold"
              style={{ border: "1px solid var(--border)" }}
              disabled={genMut.isPending || form.bgVideoUrls.filter((l) => l.trim()).length === 0}
              onClick={() =>
                genMut.mutate({
                  kind: "video_transcript",
                  payload: JSON.stringify({
                    video_urls: form.bgVideoUrls.map((l) => l.trim()).filter(Boolean),
                  }),
                })
              }
            >
              参考動画の文字起こしを依頼
            </button>
            <button
              type="button"
              aria-label="キャラチャットへ反映を依頼"
              className="rounded-lg px-3 py-2 text-sm font-semibold"
              style={{ border: "1px solid var(--border)" }}
              disabled={genMut.isPending || !charaStatus.data?.available}
              title={charaStatus.data?.available ? undefined : "連携先アプリが見つからないため利用できません"}
              onClick={() =>
                genMut.mutate({
                  kind: "chara_chat_sync",
                  payload: JSON.stringify({}),
                })
              }
            >
              キャラチャットへ反映を依頼
            </button>
          </div>

          <fieldset className="mt-4">
            <legend className="text-sm font-semibold">
              名前・バックグラウンドを大きく変える場合の固有の記憶の扱い
            </legend>
            <div className="mt-1 flex flex-wrap gap-3 text-sm">
              {(
                [
                  ["keep", "引き継ぐ"],
                  ["reset", "リセットする"],
                  ["duplicate", "複製して新しいプロファイルにする"],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className="flex min-h-9 items-center gap-1.5">
                  <input
                    type="radio"
                    name="memory-choice"
                    className="h-5 w-5"
                    checked={memoryChoice === v}
                    onChange={() => setMemoryChoice(v)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          {/* CR-24: キャラチャットに反映する */}
          <div className="mt-4">
            <CharaChatSyncField
              status={charaStatus.data}
              checked={syncChecked}
              onChange={(v) => setSyncOverride(v)}
              lastSyncedAt={profile.chara_chat_synced_at}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              aria-label="保存のみ（次回切替時に反映）"
              className="rounded-lg px-5 py-2.5 text-sm font-bold"
              style={{ border: "2px solid var(--accent)", color: "var(--accent)" }}
              disabled={saveMut.isPending || !form.name.trim()}
              onClick={() => saveMut.mutate(false)}
            >
              {saveMut.isPending ? "保存中…" : "保存のみ（次回切替時に反映）"}
            </button>
            <button
              type="button"
              aria-label="保存して今すぐ反映"
              className="rounded-lg px-5 py-2.5 text-sm font-bold text-white"
              style={{ background: "var(--accent)" }}
              disabled={saveMut.isPending || !form.name.trim()}
              onClick={() => saveMut.mutate(true)}
            >
              {saveMut.isPending ? "保存中…" : "保存して今すぐ反映"}
            </button>
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--dim)" }}>
            「保存して今すぐ反映」: 使用中のプロファイルなら反映リクエスト（口調・名前・呼び方は即時適用、画像が変われば候補生成→選択→セット）を作成し、使用中でなければ切替リクエストを作成します。どちらも作成直後にこのボタンの直下に定型文が表示されるので、それをコピーしてチャットに貼って送信すると適用されます（定型文コピペ方式）。適用されるまでは「反映待ち」と表示されます。
          </p>
          {!form.name.trim() && (
            <p className="mt-1 text-xs" style={{ color: "var(--accent)" }}>
              名前は必須です。
            </p>
          )}
          {/* CR-13: the phrase created by 「保存して今すぐ反映」 appears
              right here, directly under the button that was pressed, so
              copying it finishes in place. */}
          {phrase && phrase.origin === "save" && (
            <div
              ref={savePhraseRef}
              data-phrase-placement="under-save-button"
              className="mt-3"
            >
              <PhraseBox phrase={phrase.text} kind={phrase.kind} />
            </div>
          )}
        </section>
      )}

      {/* CR-13 fallback: right after a save the form is briefly null
          (until the refetched profile repopulates it); keep the
          save-created phrase visible in the same spot meanwhile. */}
      {!form && phrase && phrase.origin === "save" && (
        <div
          ref={savePhraseRef}
          data-phrase-placement="under-save-button"
          className="mt-3"
        >
          <PhraseBox phrase={phrase.text} kind={phrase.kind} />
        </div>
      )}

      {/* Trial conversation */}
      <section aria-label="試し会話プレビュー" className="mt-8">
        <h3 className="font-display text-lg font-bold">試し会話プレビュー</h3>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
          現在の設定で短い挨拶文の生成をチャット側に依頼します。試し会話はアバター固有の記憶には残りません。
        </p>
        <button
          type="button"
          aria-label="試し会話を依頼"
          className="mt-2 rounded-lg px-4 py-2 text-sm font-semibold text-white"
          style={{ background: "var(--accent)" }}
          disabled={genMut.isPending}
          onClick={() =>
            genMut.mutate({
              kind: "trial_conversation",
              payload: JSON.stringify({
                name: profile.name,
                speech_style: profile.speech.style,
                tuning: profile.speech.tuning,
                call_user_as: profile.call_user_as,
                speech_structured: {
                  first_person: profile.speech.structured.first_person,
                  second_person: profile.speech.structured.second_person,
                  call_user_as: profile.call_user_as,
                  catchphrase: profile.speech.structured.catchphrase,
                  memo: profile.speech.structured.memo,
                },
                speech_sources: profile.speech.sources,
                background: profile.background.text,
                user_relationship: profile.background.user_relationship ?? null,
                video_notes: profile.background.video_notes ?? null,
                flavor_level: profile.flavor?.level ?? 3,
                flavor_traits: (profile.flavor?.traits ?? []).map((t) => ({
                  ...t,
                  frequency: t.frequency ?? null,
                  effective_frequency: effectiveFlavorFrequency(t, profile.flavor?.level ?? 3),
                })),
              }),
            })
          }
        >
          試し会話を依頼
        </button>
        <ul className="mt-3 space-y-2">
          {trialResults.map((r) => (
            <li
              key={r.id}
              className="rounded-xl p-3 text-sm"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
            >
              <div className="flex items-center gap-2">
                <StatusChip status={r.status} />
                <span className="text-xs" style={{ color: "var(--dim)" }}>
                  {fmtDate(r.created_at)}
                </span>
              </div>
              {r.status === "completed" && r.result && (
                <p className="mt-2 whitespace-pre-wrap">{parseTrialText(r.result)}</p>
              )}
              {r.status === "failed" && (
                <p className="mt-2" style={{ color: "var(--accent)" }}>
                  失敗: {r.reason ?? "理由不明"}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Generation requests for this profile */}
      <section aria-label="生成リクエストの状態" className="mt-8">
        <h3 className="font-display text-lg font-bold">生成リクエスト</h3>
        {(genList.data?.requests ?? []).length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
            リクエストはありません。
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {(genList.data?.requests ?? []).map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-xl p-3 text-sm"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
              >
                <span className="font-semibold">{genKindLabel(r.kind)}</span>
                <StatusChip status={r.status} />
                <span className="text-xs" style={{ color: "var(--dim)" }}>
                  {fmtDate(r.created_at)}
                </span>
                {r.status === "failed" && (
                  <span style={{ color: "var(--accent)" }}>{r.reason ?? "理由不明"}</span>
                )}
                {canDeleteRequest(r.status) && (
                  <span className="ml-auto">
                    <RequestDeleteButton
                      ariaSubject={`${genKindLabel(r.kind)}リクエスト`}
                      deleteFn={async () =>
                        await api.deleteGenerationRequest({ request_id: r.id })
                      }
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Export */}
      <section aria-label="書き出し" className="mt-8">
        <h3 className="font-display text-lg font-bold">書き出し（JSON）</h3>
        <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
          avatar-profile v1.0 形式で書き出します。画像はファイル参照として含まれます。私の情報（固有の記憶・呼び方）を含めるかどうか選べます。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            aria-label="私の情報を含めて書き出す"
            className="rounded-lg px-3 py-2 text-sm font-semibold"
            style={{ border: "1px solid var(--border)" }}
            onClick={() => void exportJson(true)}
          >
            私の情報を含めて書き出す
          </button>
          <button
            type="button"
            aria-label="私の情報を除いて書き出す"
            className="rounded-lg px-3 py-2 text-sm font-semibold"
            style={{ border: "1px solid var(--border)" }}
            onClick={() => void exportJson(false)}
          >
            私の情報を除いて書き出す
          </button>
        </div>
      </section>

      {/* History */}
      <section aria-label="変更履歴" className="mt-8">
        <h3 className="font-display text-lg font-bold">変更履歴（最新20版）</h3>
        {(history.data?.versions ?? []).length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
            履歴はまだありません。編集を保存すると、変更前の状態がここに残ります。
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {(history.data?.versions ?? []).map((v) => (
              <li
                key={v.id}
                className="flex flex-wrap items-center gap-2 rounded-xl p-3 text-sm"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
              >
                <span className="font-semibold">{v.label}</span>
                <span style={{ color: "var(--dim)" }}>
                  {v.name} ／ {fmtDate(v.created_at)}
                </span>
                <button
                  type="button"
                  aria-label={`${fmtDate(v.created_at)}の版に戻す`}
                  className="ml-auto rounded-lg px-3 py-1.5 text-sm font-semibold"
                  style={{ border: "1px solid var(--border)" }}
                  disabled={restoreMut.isPending}
                  onClick={() => restoreMut.mutate(v.id)}
                >
                  この版に戻す
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function parseTrialText(result: string): string {
  try {
    const parsed = JSON.parse(result) as { text?: string; trial_text?: string; greeting?: string };
    return parsed.greeting ?? parsed.text ?? parsed.trial_text ?? result;
  } catch {
    return result;
  }
}

// ---------------------------------------------------------------------------
// Trash view
// ---------------------------------------------------------------------------

function TrashView({ navigate }: { navigate: (v: View) => void }) {
  const queryClient = useQueryClient();
  const trash = useQuery({
    queryKey: ["trash"],
    queryFn: () => api.listTrash({}),
  });
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const restoreMut = useMutation({
    mutationFn: async (pid: string) => await api.restoreProfile({ id: pid }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["trash"] });
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
  const purgeMut = useMutation({
    mutationFn: async (pid: string) => await api.purgeProfile({ id: pid }),
    onSuccess: () => {
      setConfirmPurge(null);
      void queryClient.invalidateQueries({ queryKey: ["trash"] });
    },
  });

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="一覧に戻る"
          className="rounded-lg px-3 py-2 text-sm"
          style={{ border: "1px solid var(--border)" }}
          onClick={() => navigate({ kind: "list" })}
        >
          ← 一覧
        </button>
        <h2 className="font-display text-xl font-bold">ゴミ箱（30日間復元可）</h2>
      </div>
      <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
        削除から30日を過ぎたプロファイルは、自動で完全削除されます。
      </p>
      {trash.isPending && <p className="mt-4 text-sm">読み込み中…</p>}
      {trash.data && trash.data.profiles.length === 0 && (
        <p className="mt-4 text-sm" style={{ color: "var(--dim)" }}>
          ゴミ箱は空です。
        </p>
      )}
      <div className="mt-4 space-y-3">
        {(trash.data?.profiles ?? []).map((p) => {
          const deletedAt = p.deleted_at ? new Date(p.deleted_at).getTime() : Date.now();
          const daysLeft = Math.max(
            0,
            30 - Math.floor((Date.now() - deletedAt) / 86_400_000),
          );
          return (
            <article
              key={p.id}
              className="flex flex-wrap items-center gap-3 rounded-2xl p-3"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
            >
              <AvatarTile profile={p} size={48} />
              <div className="min-w-0 flex-1">
                <h3 className="font-display font-bold break-all">{p.name}</h3>
                <p className="text-xs" style={{ color: "var(--dim)" }}>
                  削除: {fmtDate(p.deleted_at)} ／ 復元期限まで約{daysLeft}日
                </p>
              </div>
              <button
                type="button"
                aria-label={`${p.name}を復元する`}
                className="rounded-lg px-3 py-2 text-sm font-semibold text-white"
                style={{ background: "var(--teal)" }}
                disabled={restoreMut.isPending}
                onClick={() => restoreMut.mutate(p.id)}
              >
                復元
              </button>
              {confirmPurge === p.id ? (
                <>
                  <span className="text-sm" style={{ color: "var(--accent)" }}>
                    完全削除しますか？
                  </span>
                  <button
                    type="button"
                    aria-label={`${p.name}の完全削除を確定する`}
                    className="rounded-lg px-3 py-2 text-sm font-bold text-white"
                    style={{ background: "var(--accent)" }}
                    disabled={purgeMut.isPending}
                    onClick={() => purgeMut.mutate(p.id)}
                  >
                    完全削除
                  </button>
                  <button
                    type="button"
                    aria-label="完全削除をやめる"
                    className="rounded-lg px-3 py-2 text-sm"
                    style={{ border: "1px solid var(--border)" }}
                    onClick={() => setConfirmPurge(null)}
                  >
                    やめる
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  aria-label={`${p.name}を完全削除する`}
                  className="rounded-lg px-3 py-2 text-sm font-semibold"
                  style={{ border: "1px solid var(--accent)", color: "var(--accent)" }}
                  onClick={() => setConfirmPurge(p.id)}
                >
                  完全削除
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

export function App() {
  const [view, setView] = useState<View>({ kind: "list" });

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pt-4 pb-10">
        {view.kind === "list" && <ListView navigate={setView} />}
        {view.kind === "create" && <CreateView navigate={setView} />}
        {view.kind === "detail" && (
          <DetailView key={view.id} id={view.id} navigate={setView} />
        )}
        {view.kind === "trash" && <TrashView navigate={setView} />}
      </main>
    </div>
  );
}
