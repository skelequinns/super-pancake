import { ReactElement } from "react";
import { StageBase, StageResponse, InitialData, Message } from "@chub-ai/stages-ts";
import { LoadResponse } from "@chub-ai/stages-ts/dist/types/load";
import { getMilestoneInjection, MilestoneKey } from "./milestones";
import {
    CharacterName,
    CHARACTERS,
    STARTING_AFFECTION,
    AFFECTION_MIN,
    AFFECTION_MAX,
    MAX_DELTA,
    BASE_DELTA,
    MAX_HISTORY,
    ABSENCE_THRESHOLD,
    TIERS,
    Tier,
    CHAR_BEHAVIORS,
    CHAR_MULTIPLIERS,
} from './constants';
import { CategoryFire, analyzeText, computeNamedDeltas } from './keywords';
import { detectPresentCharacters, detectMentionedCharacters, detectDepartedCharacters, detectSceneTransition } from './sceneDetection';

// ═══════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * One completed exchange, stored in messageState.
 * Survives swipes (setState restores the old array) and session restarts
 * (reloaded from the database via the constructor).
 */
interface AnalysisHistoryEntry {
    messageExcerpt:      string;
    globalCategories:    CategoryFire[];                          // what fired in the full message
    namedChars:          CharacterName[];                         // chars explicitly named in user's message
    sceneChars:          CharacterName[];                         // activeSceneChars snapshot at beforePrompt
    namedCharCategories: Partial<Record<CharacterName, CategoryFire[]>>; // per-char context-window categories
    appliedDeltas:       Partial<Record<CharacterName, number>>;  // what was actually committed
    presentChars:        CharacterName[];
    affectionBefore:     Record<CharacterName, number>;
    affectionAfter:      Record<CharacterName, number>;
    tierChanges:         string[];
}

/**
 * Everything in MessageStateType is persisted to the database after each message
 * and restored on swipe / branch change via setState().
 */
type MessageStateType = {
    affection:              Record<CharacterName, number>;
    history:                AnalysisHistoryEntry[];
    pendingTrigger:         PendingTrigger | null; // persisted so swipes don't blow away the user's message record
    activeSceneChars:       CharacterName[];        // characters currently in-scene; pruned after ABSENCE_THRESHOLD consecutive absent turns
    absenceCounts:          Partial<Record<CharacterName, number>>; // consecutive bot responses each char has been absent from presentChars
    // ── Milestone state ──────────────────────────────────────────────────────
    firedMilestones:        string[];         // serialized Set of "Char:Tier" keys — first-time-only guard
    lilithMinAffection:     number;           // Lilith's historical minimum, used for rivalry/kindness path detection
    pendingMilestonePrompt: string | null;    // formatted injection block queued for the next beforePrompt turn
};

type ConfigType    = any;
type InitStateType = any;
type ChatStateType = any;

/**
 * Data computed in beforePrompt, persisted in messageState so it survives swipes.
 * namedDeltas AND sceneDeltas are applied immediately (before bot responds).
 * BASE_DELTA for brand-new entrants is applied in afterResponse once we know who's in the scene.
 */
interface PendingTrigger {
    messageExcerpt:      string;
    globalCategories:    CategoryFire[];
    namedDeltas:         Partial<Record<CharacterName, number>>; // deltas already applied — explicitly named chars
    namedChars:          CharacterName[];                        // chars explicitly named in user's message
    namedCharCategories: Partial<Record<CharacterName, CategoryFire[]>>; // per-char context-window fired categories
    sceneDeltas:         Partial<Record<CharacterName, number>>; // deltas already applied — activeSceneChars not named
    sceneChars:          CharacterName[];                        // activeSceneChars snapshot at beforePrompt time
    isSceneTransition:   boolean;                                // user message described leaving the current location
    travelingChars:      CharacterName[];                        // chars detected (possessive-safe) in user's transition message
    affectionBefore:     Record<CharacterName, number>;          // snapshot before ANY deltas this exchange
}


// ═══════════════════════════════════════════════════════════════
//  DEBUG COMMAND PARSING
//  Typed in the chat input; intercepted before any LLM analysis.
//
//  Syntax:
//    /status                                — print a full scene/affection/last-exchange snapshot
//    /set  [CharacterName | all]  <value>   — set affection to exact value
//    /add  [CharacterName | all]  <value>   — add (or subtract) from affection
//    /reset                                 — restore all to STARTING_AFFECTION
//
//  Examples:
//    /status
//    /set Malivorn 200
//    /add all -50
//    /reset
// ═══════════════════════════════════════════════════════════════

interface DebugCommand {
    type:   'set' | 'add' | 'reset' | 'status';
    target: CharacterName | 'all';
    value?: number;
}

function parseDebugCommand(text: string): DebugCommand | null {
    const trimmed = text.trim();

    // /status
    if (/^\/status\s*$/i.test(trimmed)) {
        return { type: 'status', target: 'all' };
    }

    // /reset
    if (/^\/reset\s*$/i.test(trimmed)) {
        return { type: 'reset', target: 'all' };
    }

    // /set [name|all] <number>
    const setMatch = trimmed.match(/^\/set\s+(\w+)\s+(-?\d+(?:\.\d+)?)\s*$/i);
    if (setMatch) {
        const raw   = setMatch[1];
        const value = parseFloat(setMatch[2]);
        if (raw.toLowerCase() === 'all') return { type: 'set', target: 'all', value };
        const char = CHARACTERS.find(c => c.toLowerCase() === raw.toLowerCase());
        if (char) return { type: 'set', target: char, value };
        return null; // unrecognised name — ignore silently
    }

    // /add [name|all] <number>
    const addMatch = trimmed.match(/^\/add\s+(\w+)\s+(-?\d+(?:\.\d+)?)\s*$/i);
    if (addMatch) {
        const raw   = addMatch[1];
        const value = parseFloat(addMatch[2]);
        if (raw.toLowerCase() === 'all') return { type: 'add', target: 'all', value };
        const char = CHARACTERS.find(c => c.toLowerCase() === raw.toLowerCase());
        if (char) return { type: 'add', target: char, value };
        return null;
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function getTier(value: number): Tier {
    return TIERS.find(t => value >= t.min && value <= t.max) ?? TIERS[3];
}

function clampAffection(value: number): number {
    return Math.max(AFFECTION_MIN, Math.min(AFFECTION_MAX, value));
}

function clampDelta(value: number): number {
    return Math.max(-MAX_DELTA, Math.min(MAX_DELTA, value));
}

/**
 * Build the stageDirections string injected into the LLM prompt each turn.
 *
 * Scene-aware rendering:
 *   - Characters in activeSceneChars → full behavior string (tier, value, prose)
 *   - Characters absent from the scene → compact "not present" note (tier + value only)
 *
 * When activeSceneChars is empty (start of session, no detection yet), falls back
 * to full detail for all characters so the LLM isn't starved of context on turn 1.
 */
function generateStageDirections(
    affection: Record<CharacterName, number>,
    activeSceneChars: CharacterName[]
): string {
    const useFullDetail = activeSceneChars.length === 0;
    const lines = CHARACTERS.map(name => {
        const tier   = getTier(affection[name]);
        const valStr = fmtVal(affection[name]);
        if (useFullDetail || activeSceneChars.includes(name)) {
            const behavior = CHAR_BEHAVIORS[name][tier.name] ?? '';
            return `  ${name} [${tier.name} ${valStr}]: ${behavior}`;
        } else {
            return `  ${name} [${tier.name} ${valStr}] — not present this scene`;
        }
    });
    return (
        `[INFERNAL COURT — AFFECTION TRACKER]\n` +
        `Relationship states. Full behavior shown for in-scene characters; absent characters listed as status only.\n` +
        lines.join('\n') + '\n' +
        `[Only characters present in this scene may have their affection changed. Max shift ±${MAX_DELTA} per character per message.]\n` +
        `[STAGE SYSTEM: Do NOT output the *Name | Tier | Value* stat lines in your response. ` +
        `These are auto-appended by the stage after your response completes. ` +
        `Begin your response directly with narrative content — never with a stat block.]`
    );
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

/** Format affection value with sign for stage directions (LLM-facing, retains decimals). */
function fmtVal(v: number): string {
    const r = Math.round(v * 100) / 100;
    const s = r % 1 === 0 ? r.toString() : r.toFixed(2);
    return r >= 0 ? `+${s}` : s;
}

function renderSymbols(tier: Tier): string {
    const ch = tier.type === 'green' ? '●' : '♥';
    return Array(tier.symbols).fill(ch).join(' ');
}

/**
 * Build the affection stats block appended to the bot's message each turn.
 * Affection is rounded to whole numbers for display; internal tracking stays fractional.
 * Format (italic, one character per line, separated from narrative by ---):
 *   *Name | Tier | rounded_value*
 *
 * Only characters identified as being in the current scene are shown.
 * Falls back to all characters when activeSceneChars is empty (e.g. session start).
 *
 * Raw affection values for ALL characters (including absent ones) are always
 * persisted in messageState.affection and accessible via the /status command.
 */
function generateStatsBlock(
    affection:        Record<CharacterName, number>,
    activeSceneChars: CharacterName[],
): string {
    // Show all characters only if scene detection hasn't fired yet (turn 1 / empty scene).
    const charsToShow = activeSceneChars.length > 0 ? activeSceneChars : CHARACTERS;
    const lines = charsToShow.map(name => {
        const tier  = getTier(affection[name]);
        const value = Math.round(affection[name]);
        return `*${name} | ${tier.name} | ${value}*`;
    });
    return lines.join('\n') + '\n\n---\n\n';
}

// ═══════════════════════════════════════════════════════════════
//  STATUS TEXT GENERATOR
//  Called by the /status debug command.
//  Returns a plain-text block the LLM echoes verbatim so the player
//  can read it in-chat or paste it elsewhere as a save-state summary.
// ═══════════════════════════════════════════════════════════════

function generateStatusText(
    affection:        Record<CharacterName, number>,
    activeSceneChars: CharacterName[],
    lastEntry:        AnalysisHistoryEntry | null,
): string {
    const SEP  = '══════════════════════════════════════════════════════════';
    const lines: string[] = [];

    lines.push(SEP);
    lines.push('  INFERNAL COURT — STATUS SNAPSHOT');
    lines.push(SEP);
    lines.push('');

    // ── SCENE ──────────────────────────────────────────────────
    const absentChars = CHARACTERS.filter(n => !activeSceneChars.includes(n));
    lines.push('SCENE');
    lines.push(`  Active : ${activeSceneChars.length > 0 ? activeSceneChars.join(', ') : '(none)'}`);
    lines.push(`  Absent : ${absentChars.length > 0 ? absentChars.join(', ') : '(none)'}`);
    lines.push('');

    // ── AFFECTION ──────────────────────────────────────────────
    lines.push('AFFECTION');
    for (const name of CHARACTERS) {
        const val    = affection[name];
        const tier   = getTier(val);
        const disp   = Math.round(val);
        const valStr = disp >= 0 ? `+${disp}` : `${disp}`;
        const mark   = activeSceneChars.includes(name) ? ' ◆' : '  ';

        // Next tier upward (higher affection).
        const nextUp = TIERS.find(t => t.min > tier.max);
        const threshStr = nextUp
            ? `→ ${nextUp.name} @ ${nextUp.min} (need ${nextUp.min - disp > 0 ? '+' : ''}${nextUp.min - disp})`
            : '(ceiling — Devoted)';

        lines.push(`  ${mark} ${name.padEnd(11)} ${tier.name.padEnd(14)} ${valStr.padStart(5)}   ${threshStr}`);
    }
    lines.push('  ◆ = currently in scene');
    lines.push('');

    // ── LAST EXCHANGE ──────────────────────────────────────────
    lines.push('LAST EXCHANGE');
    if (!lastEntry) {
        lines.push('  (no exchanges recorded yet)');
    } else {
        lines.push(`  User msg : "${lastEntry.messageExcerpt}"`);
        lines.push('');

        // Global categories (full-message pass)
        if (lastEntry.globalCategories.length > 0) {
            const catStr = lastEntry.globalCategories
                .map(c => `${c.label} (${c.delta >= 0 ? '+' : ''}${c.delta})`)
                .join('  |  ');
            lines.push(`  Global categories fired : ${catStr}`);
        } else {
            lines.push('  Global categories fired : (none)');
        }
        lines.push('');

        // Per-character breakdown
        lines.push('  Per-character results:');
        for (const name of CHARACTERS) {
            const before   = lastEntry.affectionBefore[name];
            const after    = lastEntry.affectionAfter[name];
            const delta    = lastEntry.appliedDeltas[name];
            const isNamed  = lastEntry.namedChars.includes(name);
            const isScene  = lastEntry.sceneChars.includes(name) && !isNamed;
            const isNew    = !isNamed && !isScene &&
                             lastEntry.presentChars.includes(name) &&
                             delta !== undefined && delta !== 0;

            const beforeR = Math.round(before);
            const afterR  = Math.round(after);
            const bTier   = getTier(before).name;
            const aTier   = getTier(after).name;
            const tierTag = bTier === aTier ? bTier : `${bTier} → ${aTier} ⬆`;
            const deltaStr = delta !== undefined
                ? (delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2))
                : '0';

            if (isNamed) {
                const cats        = lastEntry.namedCharCategories[name] ?? [];
                const multipliers = CHAR_MULTIPLIERS[name];

                let catDetail = '(no categories fired in context window)';
                if (cats.length > 0) {
                    catDetail = cats.map(c => {
                        const m    = multipliers[c.name] ?? 1;
                        const val2 = c.delta * m;
                        return `${c.label} ${c.delta >= 0 ? '+' : ''}${c.delta} ×${m} = ${val2 >= 0 ? '+' : ''}${val2}`;
                    }).join('  |  ');
                }

                lines.push(`    ${name.padEnd(12)} [NAMED]`);
                lines.push(`      categories : ${catDetail}`);
                lines.push(`      + base      : +${BASE_DELTA}`);
                lines.push(`      total delta : ${deltaStr}  (cap ±${MAX_DELTA})`);
                lines.push(`      affection   : ${beforeR >= 0 ? '+' : ''}${beforeR} → ${afterR >= 0 ? '+' : ''}${afterR}  [${tierTag}]`);
            } else if (isScene) {
                lines.push(`    ${name.padEnd(12)} [SCENE — no per-char multipliers]`);
                lines.push(`      global delta + base applied : ${deltaStr}`);
                lines.push(`      affection : ${beforeR >= 0 ? '+' : ''}${beforeR} → ${afterR >= 0 ? '+' : ''}${afterR}  [${tierTag}]`);
            } else if (isNew) {
                lines.push(`    ${name.padEnd(12)} [NEW ENTRANT — base delta only]`);
                lines.push(`      affection : ${beforeR >= 0 ? '+' : ''}${beforeR} → ${afterR >= 0 ? '+' : ''}${afterR}  [${tierTag}]`);
            } else {
                lines.push(`    ${name.padEnd(12)} [absent — no delta]`);
            }
        }
        lines.push('');

        // Tier changes
        if (lastEntry.tierChanges.length > 0) {
            lines.push(`  Tier changes this exchange : ${lastEntry.tierChanges.join('  |  ')}`);
        } else {
            lines.push('  Tier changes this exchange : none');
        }
    }
    lines.push('');

    // ── COMMANDS REMINDER ─────────────────────────────────────
    lines.push(SEP);
    lines.push('  /set <name|all> <val>   /add <name|all> <val>   /reset');
    lines.push(SEP);

    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
//  STAGE CLASS
// ═══════════════════════════════════════════════════════════════

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    /** Current affection — always reflects the latest applied state (including any named/scene deltas from beforePrompt). */
    affection: Record<CharacterName, number>;

    /**
     * Analysis history — persisted in messageState.
     * Restored from the database on load; rolls back correctly on swipe
     * because setState() replaces this from the restored messageState.
     */
    history: AnalysisHistoryEntry[];

    /**
     * In-flight exchange data set in beforePrompt, persisted in messageState.
     * Survives swipes (setState restores it) so the debug panel always shows
     * the current user message record even while waiting for a bot response.
     * Cleared (set to null) in afterResponse once the history entry is committed.
     */
    pendingTrigger: PendingTrigger | null;

    /**
     * Characters currently in-scene — persisted across turns.
     * Built up from bot responses (detectPresentCharacters) and pruned by
     * departure-cue detection OR after ABSENCE_THRESHOLD consecutive absent turns.
     */
    activeSceneChars: CharacterName[];

    /**
     * Consecutive bot responses each character has been absent from presentChars.
     * Resets to 0 when a character appears. Once it reaches ABSENCE_THRESHOLD,
     * the character is pruned from activeSceneChars.
     */
    absenceCounts: Partial<Record<CharacterName, number>>;

    /** Previous tier names — used to detect tier transitions for systemMessage. */
    prevTierNames: Record<CharacterName, string>;

    // ── Milestone fields ─────────────────────────────────────────────────────

    /** Keys of milestone scenes that have already fired ("Char:Tier" format). */
    firedMilestones: Set<MilestoneKey>;

    /** Lilith's all-time lowest affection value — determines rivalry/kindness path. */
    lilithMinAffection: number;

    /**
     * A formatted milestone injection block set by afterResponse when a first-time
     * tier crossing is detected.  Consumed (appended to stageDirections, then cleared)
     * by the NEXT call to beforePrompt so the LLM plays out the scene on the following turn.
     */
    pendingMilestonePrompt: string | null;

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const { messageState } = data;

        // messageState.affection is always the pre-change snapshot (from beforePrompt).
        // If a pendingTrigger exists (session restored mid-exchange), re-apply namedDeltas
        // AND sceneDeltas so the displayed affection reflects what the user already sent.
        this.affection = messageState?.affection
            ? { ...messageState.affection }
            : { ...STARTING_AFFECTION };

        this.history = messageState?.history
            ? [...messageState.history]
            : [];

        this.pendingTrigger   = messageState?.pendingTrigger  ?? null;
        this.activeSceneChars = messageState?.activeSceneChars ?? [];
        this.absenceCounts    = messageState?.absenceCounts    ?? {};

        // Milestone state — restored from messageState; defaults are safe for fresh sessions.
        this.firedMilestones        = new Set(messageState?.firedMilestones ?? []);
        this.lilithMinAffection     = messageState?.lilithMinAffection ?? STARTING_AFFECTION['Lilith'];
        this.pendingMilestonePrompt = messageState?.pendingMilestonePrompt ?? null;

        // If we're restoring a mid-exchange session, re-apply namedDeltas AND sceneDeltas
        // so the HUD shows the correct (post-send) affection values.
        if (this.pendingTrigger) {
            for (const [name, delta] of Object.entries(this.pendingTrigger.namedDeltas) as [CharacterName, number][]) {
                this.affection[name] = clampAffection(this.affection[name] + delta);
            }
            for (const [name, delta] of Object.entries(this.pendingTrigger.sceneDeltas) as [CharacterName, number][]) {
                this.affection[name] = clampAffection(this.affection[name] + delta);
            }
        }

        this.prevTierNames = Object.fromEntries(
            CHARACTERS.map(name => [name, getTier(this.affection[name]).name])
        ) as Record<CharacterName, string>;
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {
        return { success: true, error: null, initState: null, chatState: null };
    }

    /**
     * Called on swipe / branch jump.
     * Restores affection, history, AND pendingTrigger from the saved messageState.
     *
     * The messageState returned by beforePrompt stores the PRE-CHANGE affection
     * (for correct rollback) but DOES include the pendingTrigger so the debug panel
     * can continue to show the user's current message record while the new bot
     * response is being generated.
     *
     * beforePrompt() will be called again after setState() and will re-apply
     * the named deltas, so affection always ends up correct.
     */
    async setState(state: MessageStateType): Promise<void> {
        if (state?.affection) {
            this.affection = { ...state.affection };
            this.prevTierNames = Object.fromEntries(
                CHARACTERS.map(name => [name, getTier(this.affection[name]).name])
            ) as Record<CharacterName, string>;
        }
        if (state?.history) {
            this.history = [...state.history];
        }
        // Restore pendingTrigger so the debug panel keeps showing the user's message record.
        this.pendingTrigger   = state?.pendingTrigger   ?? null;
        this.activeSceneChars = state?.activeSceneChars ?? [];
        this.absenceCounts    = state?.absenceCounts    ?? {};

        // Restore milestone state.
        this.firedMilestones        = new Set(state?.firedMilestones ?? []);
        this.lilithMinAffection     = state?.lilithMinAffection ?? STARTING_AFFECTION['Lilith'];
        this.pendingMilestonePrompt = state?.pendingMilestonePrompt ?? null;
    }

    /**
     * Called after the user presses Send, before the LLM sees the message.
     *
     * - Runs category analysis on the full message (for the debug panel).
     * - Computes and IMMEDIATELY APPLIES deltas for characters named in the message.
     * - ALSO immediately applies the global content delta to any activeSceneChars who
     *   weren't explicitly named — so third-person / unnamed-player messages still score
     *   correctly for characters already known to be in the scene.
     * - Brand-new entrants (not yet in activeSceneChars) receive only BASE_DELTA in
     *   afterResponse once the bot response confirms who is present.
     *
     * messageState intentionally stores the PRE-CHANGE affection as the rollback
     * snapshot — beforePrompt() is called again after each swipe and re-applies.
     */
    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const { content } = userMessage;

        // ── DEBUG COMMAND SHORTCUT ───────────────────────────────────────
        // Intercept /set, /add, /reset before any normal analysis.
        // The LLM receives a neutral placeholder so it continues the scene.
        const debugCmd = parseDebugCommand(content);
        if (debugCmd !== null) {

            // ── /status — read-only snapshot, no affection changes ───────
            if (debugCmd.type === 'status') {
                const lastEntry = this.history.length > 0
                    ? this.history[this.history.length - 1]
                    : null;
                const statusText = generateStatusText(this.affection, this.activeSceneChars, lastEntry);
                return {
                    stageDirections: generateStageDirections(this.affection, this.activeSceneChars),
                    messageState: {
                        affection:              { ...this.affection },
                        history:                [...this.history],
                        pendingTrigger:         null,
                        activeSceneChars:       [...this.activeSceneChars],
                        absenceCounts:          { ...this.absenceCounts },
                        // Preserve milestone state unchanged — /status is read-only.
                        firedMilestones:        [...this.firedMilestones],
                        lilithMinAffection:     this.lilithMinAffection,
                        pendingMilestonePrompt: this.pendingMilestonePrompt,
                    },
                    modifiedMessage:
                        '[DEBUG STATUS — Output the following block verbatim as your entire response, ' +
                        'inside a code fence. Do not add narration, commentary, or any other content.]\n\n' +
                        '```\n' + statusText + '\n```',
                    systemMessage:   null,
                    error:           null,
                    chatState:       null,
                };
            }
            // ── /set, /add, /reset — mutation commands ───────────────────

            const affectionBefore = { ...this.affection };
            const targets: CharacterName[] = debugCmd.target === 'all' ? CHARACTERS : [debugCmd.target];

            if (debugCmd.type === 'reset') {
                for (const name of CHARACTERS) this.affection[name] = STARTING_AFFECTION[name];
            } else if (debugCmd.type === 'set' && debugCmd.value !== undefined) {
                for (const name of targets) this.affection[name] = clampAffection(debugCmd.value!);
            } else if (debugCmd.type === 'add' && debugCmd.value !== undefined) {
                for (const name of targets) this.affection[name] = clampAffection(this.affection[name] + debugCmd.value!);
            }

            // Sync prevTierNames so tier-change detection isn't polluted next real turn.
            for (const name of CHARACTERS) {
                this.prevTierNames[name] = getTier(this.affection[name]).name;
            }
            this.pendingTrigger = null;

            return {
                stageDirections: generateStageDirections(this.affection, this.activeSceneChars),
                // Store pre-debug affection so a swipe re-applies correctly.
                // Milestone state is preserved unchanged — debug commands don't trigger scenes.
                messageState: {
                    affection:              affectionBefore,
                    history:                [...this.history],
                    pendingTrigger:         null,
                    activeSceneChars:       [...this.activeSceneChars],
                    absenceCounts:          { ...this.absenceCounts },
                    firedMilestones:        [...this.firedMilestones],
                    lilithMinAffection:     this.lilithMinAffection,
                    pendingMilestonePrompt: this.pendingMilestonePrompt,
                },
                modifiedMessage: '[DEBUG: Affection values have been adjusted. Respond briefly as the narrator — give a short, atmospheric in-world confirmation that the court\'s mood has shifted, then invite {{user}} to continue. Keep it to two or three sentences.]',
                systemMessage:   null,
                error:           null,
                chatState:       null,
            };
        }
        // ── END DEBUG COMMAND ────────────────────────────────────────────

        // Snapshot affection BEFORE changes — stored in messageState for setState() rollback.
        const affectionBefore = { ...this.affection };

        // Global analysis — what categories fired across the full message (debug display).
        const globalResult      = analyzeText(content);
        // Scene chars receive no multipliers; clamp their total (keyword sum + base) to ±MAX_DELTA.
        const sceneBaseDelta    = clampDelta(globalResult.totalDelta + BASE_DELTA);
        const isSceneTransition = detectSceneTransition(content);
        // On a transition, capture who's named in the user's message (possessive-safe) as
        // the 'traveling party' — carried into afterResponse to seed the rebuilt scene.
        const travelingChars = isSceneTransition ? detectPresentCharacters(content) : [];

        // Named-character deltas — only for chars explicitly mentioned by the user.
        const { deltas: namedDeltas, namedChars, namedCharCategories } = computeNamedDeltas(content);

        // Apply named deltas immediately.
        for (const name of namedChars) {
            const delta = namedDeltas[name];
            if (delta !== undefined) {
                this.affection[name] = clampAffection(this.affection[name] + delta);
            }
        }

        // Active-scene chars not named by the user → apply the global content delta now.
        // These characters are known to be in the scene from prior bot responses, so the
        // player's message is implicitly addressed to them even without explicit naming.
        // No per-character multipliers for the scene bucket — only named interactions get them.
        const sceneOnlyChars = this.activeSceneChars.filter(n => !namedChars.includes(n));
        const sceneDeltas: Partial<Record<CharacterName, number>> = {};
        for (const name of sceneOnlyChars) {
            sceneDeltas[name] = sceneBaseDelta;
            this.affection[name] = clampAffection(this.affection[name] + sceneBaseDelta);
        }

        // Build pendingTrigger — persisted in messageState so it survives swipes.
        this.pendingTrigger = {
            messageExcerpt:      content.length > 72 ? content.slice(0, 70) + '…' : content,
            globalCategories:    globalResult.firedCategories,
            namedDeltas,
            namedChars,
            namedCharCategories,
            sceneDeltas,
            sceneChars:          [...this.activeSceneChars],
            isSceneTransition,
            travelingChars,
            affectionBefore,
        };

        // Consume any pending milestone — append to stageDirections for this turn's LLM context.
        // Cleared here so afterResponse starts with a clean slate for the next tier-cross check.
        const milestoneToInject         = this.pendingMilestonePrompt;
        this.pendingMilestonePrompt     = null;

        const baseDirections  = generateStageDirections(this.affection, this.activeSceneChars);
        const stageDirections = milestoneToInject
            ? baseDirections + '\n\n' + milestoneToInject
            : baseDirections;

        return {
            stageDirections,
            // Store PRE-CHANGE affection so setState() rollback lands in the right place.
            // activeSceneChars and absenceCounts are unchanged this turn — they update in afterResponse.
            // pendingMilestonePrompt is null here (consumed above); afterResponse may set a new one.
            messageState: {
                affection:              affectionBefore,
                history:                [...this.history],
                pendingTrigger:         this.pendingTrigger,
                activeSceneChars:       [...this.activeSceneChars],
                absenceCounts:          { ...this.absenceCounts },
                firedMilestones:        [...this.firedMilestones],
                lilithMinAffection:     this.lilithMinAffection,
                pendingMilestonePrompt: null,
            },
            modifiedMessage: null,
            systemMessage:   null,
            error:           null,
            chatState:       null,
        };
    }

    /**
     * Called after the LLM generates a response.
     *
     * Named-character and active-scene-character deltas were already applied in beforePrompt.
     * Here we:
     *   1. Detect which characters appear in the bot response.
     *   2. Detect departures — characters whose name appears near an exit cue.
     *   3. Update activeSceneChars: add newly-detected, remove departed.
     *   4. Apply BASE_DELTA only to brand-new entrants (chars detected now but not in
     *      activeSceneChars at beforePrompt time and not named by the user).
     *
     * Builds the full AnalysisHistoryEntry, commits it to history, and clears pendingTrigger.
     */
    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const rawContent            = botMessage.content ?? '';

        const trigger               = this.pendingTrigger;
        const namedChars            = trigger?.namedChars            ?? [];
        const namedDeltas           = trigger?.namedDeltas           ?? {};
        const namedCharCategories   = trigger?.namedCharCategories   ?? {};
        const sceneChars            = trigger?.sceneChars            ?? [];
        const sceneDeltas           = trigger?.sceneDeltas           ?? {};
        const isSceneTransition     = trigger?.isSceneTransition     ?? false;
        const travelingChars        = trigger?.travelingChars        ?? [];

        const content = rawContent;

        // affectionBefore = snapshot taken in beforePrompt (before ANY deltas this exchange).
        const affectionBefore = trigger?.affectionBefore ?? { ...this.affection };

        // Characters mentioned by name in the bot's response (possessive-safe).
        const presentChars = detectPresentCharacters(content);

        if (isSceneTransition) {
            // Scene transition: wipe and rebuild from two sources:
            //   1. travelingChars — characters the user named (possessive-safe) in their
            //      transition message; they're clearly moving with {{user}}.
            //   2. presentChars — characters the bot confirmed in the new location.
            // Possessive-safe detection on both sides keeps reference-only mentions out.
            this.activeSceneChars = [...new Set([...travelingChars, ...presentChars])] as CharacterName[];
            // Reset absence counts on a scene transition.
            this.absenceCounts = {};
        } else {
            // Normal turn: add newly-detected chars, remove explicitly departed.
            const allKnownChars = [...new Set([...this.activeSceneChars, ...presentChars])] as CharacterName[];
            const departedChars = detectDepartedCharacters(content, allKnownChars);
            const afterDeparture = [...new Set([...this.activeSceneChars, ...presentChars])]
                .filter(n => !departedChars.includes(n)) as CharacterName[];

            // Absence-based pruning: track how many consecutive turns each active char
            // has been absent from the bot's response. Prune after ABSENCE_THRESHOLD turns.
            //
            // IMPORTANT: use detectMentionedCharacters (possessive-inclusive) for the
            // reset check — not detectPresentCharacters (possessive-safe). A character
            // referenced as "Beelzebub's chair" or "Mammon's pen" is clearly present;
            // treating them as absent would cause spurious pruning after two such turns.
            const mentionedChars = detectMentionedCharacters(content);

            // Only update absence counts when the bot actually names at least one character.
            // If the response uses pronouns only (mentionedChars is empty), the LLM is
            // writing a pronoun-focused scene — preserve the current scene composition
            // rather than incrementing absence counters and potentially pruning valid
            // characters who are clearly still present but never named by the narrator.
            if (mentionedChars.length > 0) {
                for (const name of CHARACTERS) {
                    if (mentionedChars.includes(name)) {
                        // Character was mentioned (even possessively) — reset their absence counter.
                        this.absenceCounts[name] = 0;
                    } else if (afterDeparture.includes(name)) {
                        // Character is still listed as active but wasn't mentioned at all this turn.
                        this.absenceCounts[name] = (this.absenceCounts[name] ?? 0) + 1;
                    }
                }
            }

            this.activeSceneChars = afterDeparture
                .filter(n => (this.absenceCounts[n] ?? 0) < ABSENCE_THRESHOLD);
        }

        // Already-processed chars: named by user OR known in active scene at beforePrompt time.
        const alreadyProcessed = new Set([...namedChars, ...sceneChars]);

        // Brand-new entrants: detected in response, not already processed.
        // They get BASE_DELTA — we couldn't apply a content delta before now.
        const newEntrants = presentChars.filter(n => !alreadyProcessed.has(n));

        // ── SWIPE-SAFE affection computation ────────────────────────────────
        // We always recompute from the clean pre-exchange snapshot (affectionBefore)
        // rather than from this.affection.  This makes the result identical whether
        // setState was called with beforePrompt's state OR afterResponse's state:
        //   • Normal flow: affectionBefore = pre-change (set at start of beforePrompt)
        //     → named + scene deltas were also applied to this.affection in beforePrompt;
        //       reapplying them here from affectionBefore gives the same final value.
        //   • Swipe where setState received the post-change afterResponse state:
        //     this.affection may already include the previous round's deltas, but
        //     affectionBefore is stored in pendingTrigger and is always the correct
        //     snapshot — so recomputing from it produces the right result regardless.
        const newAffection: Record<CharacterName, number> = { ...affectionBefore };

        // Apply named-character deltas (computed in beforePrompt).
        for (const [name, delta] of Object.entries(namedDeltas) as [CharacterName, number][]) {
            newAffection[name] = clampAffection(newAffection[name] + delta);
        }

        // Apply active-scene deltas (computed in beforePrompt for unnamed scene chars).
        for (const [name, delta] of Object.entries(sceneDeltas) as [CharacterName, number][]) {
            newAffection[name] = clampAffection(newAffection[name] + delta);
        }

        // Merge all applied deltas for the history entry.
        const appliedDeltas: Partial<Record<CharacterName, number>> = { ...namedDeltas };
        for (const [name, delta] of Object.entries(sceneDeltas) as [CharacterName, number][]) {
            appliedDeltas[name] = (appliedDeltas[name] ?? 0) + delta;
        }

        // Apply BASE_DELTA to brand-new entrants now.
        // Guard: only when a real user message triggered this cycle.
        // If trigger is null (e.g. the opening bot message), no user input exists
        // to justify an affection change, so we skip it entirely.
        if (trigger !== null) {
            for (const name of newEntrants) {
                newAffection[name]  = clampAffection(newAffection[name] + BASE_DELTA);
                appliedDeltas[name] = (appliedDeltas[name] ?? 0) + BASE_DELTA;
            }
        }

        this.affection = newAffection;

        // Keep Lilith's historical minimum current — used for rivalry/kindness path detection.
        if (newAffection['Lilith'] < this.lilithMinAffection) {
            this.lilithMinAffection = newAffection['Lilith'];
        }

        // Detect tier transitions (from affectionBefore → newAffection).
        // Collect per-character detail so the milestone check knows who moved where.
        const tierChanges: string[] = [];
        const tierChangeDetails: Array<{ name: CharacterName; newTier: string }> = [];
        for (const name of CHARACTERS) {
            const newTier = getTier(newAffection[name]).name;
            if (newTier !== this.prevTierNames[name]) {
                tierChanges.push(`${name}: ${this.prevTierNames[name]} → ${newTier}`);
                tierChangeDetails.push({ name, newTier });
                this.prevTierNames[name] = newTier;
            }
        }

        // Milestone check — only runs when at least one tier boundary was crossed this turn.
        // One milestone fires at most per turn (first eligible character wins).
        // getMilestoneInjection() is imported from milestones.ts and is only called here.
        if (tierChangeDetails.length > 0) {
            for (const { name, newTier } of tierChangeDetails) {
                const result = getMilestoneInjection(
                    name,
                    newTier,
                    this.firedMilestones,
                    this.lilithMinAffection,
                );
                if (result) {
                    this.firedMilestones.add(result.key);
                    this.pendingMilestonePrompt = result.injection;
                    break; // one milestone per turn
                }
            }
        }

        // Build and append history entry.
        const entry: AnalysisHistoryEntry = {
            messageExcerpt:      trigger?.messageExcerpt   ?? '—',
            globalCategories:    trigger?.globalCategories ?? [],
            namedChars,
            sceneChars,
            namedCharCategories,
            appliedDeltas,
            presentChars,
            affectionBefore,
            affectionAfter:      { ...newAffection },
            tierChanges,
        };
        this.history        = [...this.history, entry].slice(-MAX_HISTORY);
        this.pendingTrigger = null;

        const systemMessage = tierChanges.length > 0
            ? `[Court Observation — ${tierChanges.join(' | ')}]`
            : null;

        return {
            stageDirections: null,
            messageState: {
                affection:              { ...newAffection },
                history:                [...this.history],
                pendingTrigger:         null,
                activeSceneChars:       [...this.activeSceneChars],
                absenceCounts:          { ...this.absenceCounts },
                firedMilestones:        [...this.firedMilestones],
                lilithMinAffection:     this.lilithMinAffection,
                pendingMilestonePrompt: this.pendingMilestonePrompt,
            },
            // Append rounded affection stats to every bot message — scene characters only.
            // Full affection for all characters is persisted in messageState regardless.
            modifiedMessage: generateStatsBlock(newAffection, this.activeSceneChars) + content,
            systemMessage,
            error:           null,
            chatState:       null,
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  RENDER
    //  Stats are appended directly to the bot's message via
    //  modifiedMessage in afterResponse — no sidebar UI needed.
    // ═══════════════════════════════════════════════════════════

    render(): ReactElement {
        return <div style={{ display: 'none' }} />;
    }
}
