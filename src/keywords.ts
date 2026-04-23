// ═══════════════════════════════════════════════════════════════
//  KEYWORD ANALYSIS
//  Pure text-analysis functions, decoupled from the stage lifecycle.
//  All functions are stateless — safe to unit-test in isolation.
// ═══════════════════════════════════════════════════════════════

import { CharacterName, CHARACTERS, CHAR_MULTIPLIERS, BASE_DELTA, MAX_DELTA } from './constants';

// ── Types ────────────────────────────────────────────────────────────────────

/** One keyword category that fired during analysis. */
export interface CategoryFire {
    name:  string;   // internal id
    label: string;   // display label
    delta: number;   // the delta this category contributed
}

/** A keyword category — fires its delta once if any pattern matches. */
export interface KeywordCategory {
    name:     string;
    label:    string;
    delta:    number;
    patterns: RegExp[];
    /** If this category fires, skip checking these other categories entirely. */
    excludes?: string[];
}

export interface AnalysisResult {
    firedCategories: CategoryFire[];
    totalDelta:      number;   // raw sum of fired deltas, NOT clamped
}

// ── Categories ───────────────────────────────────────────────────────────────
//  Negatives are listed first so their `excludes` can suppress
//  positive categories before they are ever checked.
//  Each category fires its delta ONCE if any pattern matches.
//  Categories are checked against a per-character context window
//  when the character is named, or the full message otherwise.

export const CATEGORIES: KeywordCategory[] = [
    // ── NEGATIVES FIRST ──────────────────────────────────────────────
    {
        name: 'rude', label: 'Hostile', delta: -2,
        // If rude fires, romantic/compliment/humor/friendly cannot also fire.
        excludes: ['romantic', 'compliment', 'humor', 'friendly'],
        patterns: [
            /\bi hate you\b/i,                      /\bi despise you\b/i,
            /\byou'?re (?:stupid|pathetic|worthless|vile|disgusting|a monster|a traitor)\b/i,
            /\byou disgust me\b/i,                  /\bshut (?:the fuck )?up\b/i,
            /\bgo away\b/i,                         /\bget away from me\b/i,
            /\bstay back\b/i,                       /\bleave me alone\b/i,
            /\bdon'?t (?:you )?touch me\b/i,        /\bstay away from me\b/i,
            /\bi don'?t care about you\b/i,         /\byou'?re a traitor\b/i,
            /\bnever forgive you\b/i,               /\bi'?m done with you\b/i,
            /\bi don'?t want you\b/i,               /\byou'?re nothing (?:to me)?\b/i,
            /\bi don'?t trust you\b/i,              /\bnever trust you\b/i,
            /\bi don'?t love you\b/i,               /\bi don'?t need you\b/i,
            /\byou don'?t matter\b/i,               /\bi'?m not yours\b/i,
            /\bi will never be yours\b/i,           /\bi will never choose you\b/i,
            /\bi don'?t like you\b/i,
            /\bdon'?t want to (?:spend time|be) with you\b/i,
        ],
    },
    {
        name: 'dismissive', label: 'Dismissive', delta: -1,
        excludes: ['compliment', 'humor', 'friendly'],
        patterns: [
            /\byou'?re (?:so )?boring\b/i,
            /\byou(?:'?re| are) (?:so )?annoying\b/i,
            /\byou(?:'?re| are) (?:so )?irritating\b/i,
            /\byou(?:'?re| are) (?:so )?frustrating\b/i,
            /\bi don'?t care about you\b/i,             /\bnot interested\b/i,
            /\bi'?m indifferent\b/i,                    /\birrelevant\b/i,
            /\btired of you\b/i,                        /\bcan'?t stand you\b/i,
            /\byou'?re (?:just )?awful\b/i,             /\byou'?re (?:just )?terrible\b/i,
            /\bi'?m not listening\b/i,                  /\bi don'?t want to hear\b/i,
        ],
    },

    // ── POSITIVES (only reached if not excluded by a negative above) ──
    {
        name: 'romantic', label: 'Romantic', delta: 2,
        patterns: [
            /\bi love you\b/i,                          /\bi adore you\b/i,
            /\bi want you\b/i,                          /\bi need you (?:here|with me|by my side)\b/i,
            /\bchoose you\b/i,                          /\bi choose you\b/i,
            /\bkiss(?:ed)? (?:you|me|your)\b/i,
            /\bhold (?:me|you)\b/i,                     /\bheld (?:me|you)\b/i,
            /\btouch (?:me|you|your)\b/i,
            /\bstay with me\b/i,                        /\bcome closer\b/i,
            /\byou (?:really )?matter (?:to me)?\b/i,
            /\bi'?m yours\b/i,                          /\byours alone\b/i,
            /\bwant to be with you\b/i,                 /\bbe with you\b/i,
            /\bnever (?:want to )?leave you\b/i,        /\bi'?ll never leave\b/i,
            /\bmy heart\b/i,                            /\bdevoted to you\b/i,
            /\bonly (?:ever )?you\b/i,                  /\bcloser to me\b/i,
            /\bspend (?:my life|forever|time) with you\b/i,
            /\bi'?d rather be with you\b/i,
            /\bcan'?t stop thinking (?:about you|of you)\b/i,
            /\bprotect you\b/i,                         /\bkeep you safe\b/i,
            /\bwon'?t let (?:anyone|them) hurt you\b/i,
            /\bjealous\b/i,                             /\bbelonging\b/i,
        ],
    },
    {
        name: 'compliment', label: 'Compliment', delta: 1,
        patterns: [
            // Appearance & character — require "you're/you are/how/so" prefix for generic adjectives
            /\byou'?re (?:so |truly |simply |absolutely )?\b(?:beautiful|gorgeous|stunning|magnificent|radiant|exquisite|handsome|lovely|enchanting)\b/i,
            /\bhow (?:beautiful|gorgeous|stunning|radiant|lovely|elegant|graceful)\b/i,
            /\byou'?re (?:so |truly |quite )?\b(?:brilliant|clever|wise|intelligent|perceptive|remarkable|extraordinary|incredible|formidable)\b/i,
            /\byou'?re (?:so |truly |quite )?\b(?:kind|generous|thoughtful|caring|warm|brave|strong|powerful)\b/i,
            /\bhow (?:clever|wise|brilliant|kind|brave|thoughtful|perceptive)\b/i,
            // These are specific enough to stand alone
            /\bbreathtaking\b/i,                        /\bcaptivating\b/i,
            /\bfascinating\b/i,                         /\bcompelling\b/i,
            /\belegant\b/i,                             /\bgraceful\b/i,
            /\bthank you\b/i,                           /\bi appreciate (?:you|that|it|this)\b/i,
            /\bgrateful (?:for you|to you|that you)\b/i,
            /\bi trust you\b/i,                         /\bi like you\b/i,
            /\byou'?re right\b/i,                       /\bwell done\b/i,
            /\bi'?m impressed\b/i,                      /\bi (?:really )?respect you\b/i,
            /\bi (?:truly |really )?admire you\b/i,
            /\byou(?:'re| are) (?:truly |really )?amazing\b/i,
            /\byou(?:'re| are) (?:truly |really )?wonderful\b/i,
            /\byou(?:'re| are) (?:truly |really )?impressive\b/i,
        ],
    },
    {
        name: 'friendly', label: 'Friendly', delta: 1,
        patterns: [
            // Greetings & warm check-ins
            /\bgood (?:morning|afternoon|evening|day)\b/i,
            /\bhow are you\b/i,
            /\bhope you(?:'re| are) (?:doing )?well\b/i,
            /\bnice to (?:see|meet) you\b/i,
            /\bglad (?:to see you|you(?:'re| are) here|you came)\b/i,
            /\bhappy (?:to see you|you(?:'re| are) here|you came)\b/i,
            /\bsmil(?:es|ing)?\b/i,
            /\bhug(?:s|ged|ging)?\b/i,

            // Offers of help or company
            /\bcan i help(?: you)?\b/i,                 /\blet me help\b/i,
            /\bi'?ll help(?: you)?\b/i,
            /\bwant (?:some )?company\b/i,
            /\bjoin me\b/i,                             /\bwalk with me\b/i,
            /\bsit with me\b/i,                         /\bcome with me\b/i,
            // Friendly gestures / thoughtfulness
            /\bbrought (?:you|this|something)\b/i,
            /\bmade (?:this |something )?for you\b/i,
            /\bthought (?:of you|you might)\b/i,
            // Friendship / belonging (platonic)
            /\bwe(?:'re| are) friends\b/i,              /\bbe friends\b/i,
            /\bmy friend\b/i,
            /\bconsider you (?:a |my )?friend\b/i,
            // Warm presence & enjoying company
            /\bgood to have you\b/i,
            /\bnice (?:talking|chatting) (?:with|to) you\b/i,
            /\bgood (?:talking|chatting) (?:with|to) you\b/i,
            /\benjoy (?:your )?company\b/i,
            /\blike (?:your )?company\b/i,
            /\bi'?m here for you\b/i,
            /\byou'?re not alone\b/i,
        ],
    },
    {
        name: 'vulnerability', label: 'Vulnerable', delta: 1,
        // No excludes — fear and pain are affection-relevant even in hostile messages.
        patterns: [
            /\b(?:i'?m |i am |i feel |i'?ve been )(?:so |really |terribly )?scared\b/i,
            /\b(?:i'?m |i am |i feel |i'?ve been )(?:so |really |terribly )?afraid\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?frightened\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?terrified\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?worried\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?anxious\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?nervous\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?alone\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?lonely\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?lost\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?confused\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?broken\b/i,
            /\b(?:i'?m |i am |i feel )(?:so |really )?overwhelmed\b/i,
            /\bi(?:'m| am) (?:in|so much) pain\b/i,
            /\b(?:i'?m |i am |i'?ve been )(?:really )?hurt\b/i,
            /\bcrying\b/i, /\bcries\b/i, /\bsobs\b/i, /\bsobbing\b/i,
            /\btears (?:in my eyes|down my (?:face|cheeks)|fell|streamed|pooled)\b/i,
            /\bweeping\b/i,
            /\bhelp (?:me|us)\b/i,                      /\bplease help\b/i,
            /\b(?:i'?m |i am )struggling\b/i,
            /\bfalling apart\b/i,                       /\bvulnerable\b/i,
            /\b(?:i feel |i'?m |i am )(?:so )?exposed\b/i,
            /\b(?:i feel |i'?m )(?:so )?ashamed\b/i,
            /\b(?:i'?m |i feel )(?:so )?embarrassed\b/i,
            /\bopening up\b/i,
            /\bdon'?t know what to do\b/i,
            /\bno one (?:cares|is here|understands)\b/i,
            /\bnightmare\b/i,                           /\bdespair\b/i,
            /\b(?:i feel |i'?m |i am )(?:so )?hopeless\b/i,
            /\bweakness\b/i,
        ],
    },
    {
        name: 'asking_about', label: 'Curious About You', delta: 1,
        patterns: [
            /\bi want to know (?:more )?about you\b/i,
            /\bare you (?:alright|okay|all right|ok)\b/i,
            /\bcan i do anything (?:for you)?\b/i,
            /\btell me about yourself\b/i,
            /\bwhat (?:do|did) you (?:think|feel|want|believe|enjoy|miss|love|fear)\b/i,
            /\bwhat (?:is|was) it like (?:for you)?\b/i,
            /\bwhat matters to you\b/i,                 /\bwhat'?s important to you\b/i,
            /\bwho are you\b/i,                         /\bwhat are you like\b/i,
            /\bdo you remember\b/i,                     /\bhave you ever\b/i,
            /\bwhat happened to you\b/i,                /\bwhat made you (?:this way|who you are)\b/i,
            /\bwhat do you (?:enjoy|miss|love|fear|believe|want)\b/i,
            /\bwhat were you (?:like|before)\b/i,
            /\bdo you (?:ever think|ever feel|ever wish)\b/i,
            /\bhow do you (?:feel|see it|feel about)\b/i,
            /\btell me something (?:about you|i don'?t know)\b/i,
            /\bdo you like (?:it|that|this|me|her|him)\b/i,
        ],
    },
    {
        name: 'humor', label: 'Playful', delta: 1,
        patterns: [
            /\b(?:i )?laugh(?:ed|ing)?\b/i,             /\bchuckl(?:e|ed|ing)\b/i,
            /\bgiggl(?:e|ed|ing)\b/i,
            /\bthat'?s (?:so |really )?funny\b/i,
            /\byou'?re (?:so |really )?funny\b/i,
            /\bhilarious\b/i,                           /\bamusing\b/i,
            /\bwitty\b/i,                               /\bthat'?s (?:a good |a great )?joke\b/i,
            /\b(?:a )?playful\b/i,                      /\bjesting\b/i,
            /\bhumou?r\b/i,                             /\bdelightful\b/i,
            /\bhaha\b/i,                                /\bgrin(?:ned|ning)?\b/i,
        ],
    },
    {
        name: 'reconciliation', label: 'Apologetic', delta: 1,
        patterns: [
            /\bi'?m (?:so |truly |really )?sorry\b/i,
            /\bi apologize\b/i,
            /\bforgive (?:me|us)\b/i,
            /\bi was wrong\b/i,                         /\bi made a mistake\b/i,
            /\bi (?:didn'?t mean|never meant) to (?:hurt|upset)\b/i,
            /\bplease (?:don'?t go|stay|hear me out)\b/i,
            /\btruce\b/i,
            /\bstart over\b/i,                          /\bgive (?:me|us) another chance\b/i,
        ],
    },
];

// ── Analysis functions ────────────────────────────────────────────────────────

/**
 * Run category analysis on a text string.
 * Each category fires at most once — matching multiple keywords within
 * the same category does not stack its delta.
 *
 * Negative categories (rude, dismissive) are evaluated before positives.
 * When a negative fires, any categories listed in its `excludes` array are
 * skipped entirely — preventing "I hate you, you're gorgeous" from awarding
 * a compliment bonus alongside the hostility penalty.
 */
export function analyzeText(text: string): AnalysisResult {
    const fired: CategoryFire[] = [];
    const excluded = new Set<string>();

    // Negatives are already first in the CATEGORIES array; this sort is a
    // safety net in case the order ever changes.
    const sorted = [
        ...CATEGORIES.filter(c => c.delta < 0),
        ...CATEGORIES.filter(c => c.delta >= 0),
    ];

    for (const cat of sorted) {
        if (excluded.has(cat.name)) continue;
        if (cat.patterns.some(p => p.test(text))) {
            fired.push({ name: cat.name, label: cat.label, delta: cat.delta });
            cat.excludes?.forEach(name => excluded.add(name));
        }
    }

    const totalDelta = fired.reduce((sum, c) => sum + c.delta, 0);
    return { firedCategories: fired, totalDelta };
}

/**
 * Compute affection deltas ONLY for characters explicitly named in the user's message.
 * Uses a per-character context window so only sentiment near the character's name scores.
 *
 * For each named character, per-category multipliers from CHAR_MULTIPLIERS are applied
 * to each fired category's delta before summing. BASE_DELTA is added last, and the
 * complete total is then clamped to ±MAX_DELTA.
 *
 * Characters not named here receive only BASE_DELTA (in afterResponse, once we know
 * who is actually in the scene) with no multiplier applied.
 */
export function computeNamedDeltas(text: string): {
    deltas:              Partial<Record<CharacterName, number>>;
    namedChars:          CharacterName[];
    namedCharCategories: Partial<Record<CharacterName, CategoryFire[]>>;
} {
    const deltas:              Partial<Record<CharacterName, number>>          = {};
    const namedChars:          CharacterName[]                                  = [];
    const namedCharCategories: Partial<Record<CharacterName, CategoryFire[]>> = {};

    for (const name of CHARACTERS) {
        const re      = new RegExp(`\\b${name}\\b`, 'gi');
        const matches = [...text.matchAll(re)];

        if (matches.length === 0) continue;

        namedChars.push(name);

        const WINDOW = 300;
        const ranges: [number, number][] = matches.map(m => [
            Math.max(0, m.index!),
            Math.min(text.length, m.index! + name.length + WINDOW),
        ]);
        const extended: [number, number][] = ranges.map(([start, end]) => [
            Math.max(0, start - WINDOW), end,
        ]);
        extended.sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [];
        for (const [s, e] of extended) {
            if (merged.length > 0 && s <= merged[merged.length - 1][1]) {
                merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
            } else {
                merged.push([s, e]);
            }
        }

        const context      = merged.map(([s, e]) => text.slice(s, e)).join(' … ');
        const result       = analyzeText(context);
        const multipliers  = CHAR_MULTIPLIERS[name];

        // Store the raw fired categories for this character's context window (used by /status).
        namedCharCategories[name] = result.firedCategories;

        // Apply per-character multiplier to each fired category, then sum.
        let multipliedSum = 0;
        for (const cat of result.firedCategories) {
            multipliedSum += cat.delta * (multipliers[cat.name] ?? 1);
        }

        // Add BASE_DELTA last, then clamp the complete final total to ±MAX_DELTA.
        deltas[name] = clampDelta(multipliedSum + BASE_DELTA);
    }

    return { deltas, namedChars, namedCharCategories };
}

// ── Internal helpers (not exported — only used within this module) ────────────

function clampDelta(value: number): number {
    return Math.max(-MAX_DELTA, Math.min(MAX_DELTA, value));
}
