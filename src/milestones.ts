// ═══════════════════════════════════════════════════════════════
//  MILESTONE EVENT INJECTION
//
//  Milestone scenes are one-time narrative prompts injected into
//  stageDirections when a character crosses into a milestone tier
//  for the first time.  This module is self-contained — it has no
//  knowledge of Stage internals, affection math, or the HUD.
//
//  Stage.tsx calls getMilestoneInjection() ONLY when a tier change
//  has been detected, so this module is never evaluated per-message.
// ═══════════════════════════════════════════════════════════════

// ── TYPES ────────────────────────────────────────────────────────────────────

/**
 * Tier names that carry milestone scene prompts.
 * Lilith also has an 'Enemies' milestone (her confrontation scene).
 */
export type MilestoneTier =
    | 'Rivalmance'
    | 'Enemies'
    | 'Crushing'
    | 'Smitten'
    | 'Devoted';

/**
 * Opaque string key serialized into messageState.firedMilestones.
 * Format: "CharName:TierName" or "Lilith:Crushing:kindness" etc.
 */
export type MilestoneKey = string;

// ── PATH DETECTION (Lilith only) ─────────────────────────────────────────────

/**
 * Lilith has branching milestone scenes for Crushing and Smitten.
 * The Rivalry path fires if she ever dipped into Enemies tier (-76 or lower).
 * Otherwise Kindness path.
 *
 * @param lilithMinAffection - Lilith's historical minimum affection value
 */
export function getLilithPath(lilithMinAffection: number): 'kindness' | 'rivalry' {
    return lilithMinAffection <= -76 ? 'rivalry' : 'kindness';
}

// ── KEY BUILDER ───────────────────────────────────────────────────────────────

/**
 * Build the deduplication key for a character × tier combination.
 * Lilith's Crushing and Smitten keys include the path suffix.
 */
export function buildMilestoneKey(
    char:       string,
    tier:       string,
    lilithPath?: 'kindness' | 'rivalry'
): MilestoneKey {
    if (char === 'Lilith' && lilithPath && (tier === 'Crushing' || tier === 'Smitten')) {
        return `${char}:${tier}:${lilithPath}`;
    }
    return `${char}:${tier}`;
}

// ── MAIN ENTRY POINT ──────────────────────────────────────────────────────────

/**
 * Returns a formatted stageDirections injection block for a character crossing
 * into a milestone tier, or null if:
 *   - the tier has no milestone prompt,
 *   - this key has already fired (first-time-only rule), or
 *   - no prompt text is registered for the combination.
 *
 * Only call this inside a tier-change check — never on every message.
 *
 * @param char               Character name
 * @param tier               The tier just entered
 * @param firedMilestones    Set of already-fired keys (from messageState)
 * @param lilithMinAffection Lilith's all-time minimum affection (path detection)
 */
export function getMilestoneInjection(
    char:               string,
    tier:               string,
    firedMilestones:    ReadonlySet<MilestoneKey>,
    lilithMinAffection: number,
): { injection: string; key: MilestoneKey } | null {

    const MILESTONE_TIERS: ReadonlySet<string> = new Set([
        'Rivalmance', 'Enemies', 'Crushing', 'Smitten', 'Devoted',
    ]);

    if (!MILESTONE_TIERS.has(tier)) return null;

    const lilithPath = char === 'Lilith' ? getLilithPath(lilithMinAffection) : undefined;
    const key        = buildMilestoneKey(char, tier, lilithPath);

    if (firedMilestones.has(key)) return null;

    const prompt = MILESTONE_PROMPTS[key];
    if (!prompt) return null;

    const injection = formatMilestoneBlock(char, tier, prompt);
    return { injection, key };
}

// ── FORMATTER ─────────────────────────────────────────────────────────────────

/**
 * Wraps a raw milestone prompt in the stageDirections framing block.
 * Kept here so Stage.tsx has zero formatting knowledge of milestone scenes.
 */
function formatMilestoneBlock(char: string, tier: string, prompt: string): string {
    return (
        `[MILESTONE EVENT — ${char.toUpperCase()}: ${tier.toUpperCase()}]\n` +
        `A relationship threshold has been crossed for the first time. ` +
        `Organically weave the following scenario into your next response as the primary narrative beat. ` +
        `Do not summarize it — play it out with the same care as any authored scene. ` +
        `Once the moment has been established, return to normal scene flow.\n\n` +
        prompt + `\n\n` +
        `[END MILESTONE SCENE]`
    );
}

// ── PROMPT REGISTRY ───────────────────────────────────────────────────────────
//  All milestone scene prompts from prompts.txt, verbatim.
//  Keys: "CharName:TierName" — or "Lilith:Crushing:path" / "Lilith:Smitten:path".

const MILESTONE_PROMPTS: Readonly<Record<MilestoneKey, string>> = {

    // ── MALIVORN ──────────────────────────────────────────────────────────────

    'Malivorn:Rivalmance':
        `Malivorn summons {{user}} to his chambers and tells her, with complete composure, that she is a disruption. The court functioned before she arrived. Whatever she imagines is happening here, she is wrong about it. He makes an ironclad case for her insignificance. He cannot look at her while he delivers it. When she leaves, he doesn't move for a long time. He does not examine why he needed her in the room to tell her she didn't matter.`,

    'Malivorn:Crushing':
        `Malivorn summons {{user}} to the war room under the pretense of a briefing — there is intelligence she "should understand" about the Fracture War's current front. The briefing is real. So is the hour he keeps her there after it ends, asking questions about her thoughts on strategy she has no reason to have opinions about. He does not acknowledge this. He is not ready to acknowledge this.`,

    'Malivorn:Smitten':
        `Malivorn takes {{user}} to the Scorched Gallery — a sealed wing of the Citadel containing relics from before the Sundering. He does not explain why he is showing her. He watches her look at things that predate recorded history and says almost nothing. What little he does say is honest in a way that makes the silence afterward feel enormous.`,

    'Malivorn:Devoted':
        `Malivorn does not sleep. {{user}} finds him at the edge of the Citadel's highest parapet at an hour no one should be awake. He does not order her away. He does not pretend he was doing something else. For the first time, he simply lets her stand beside him — and says the one thing he has never said to anything he has ever wanted to keep.`,

    // ── ASMODEUS ──────────────────────────────────────────────────────────────

    'Asmodeus:Rivalmance':
        `Asmodeus laid a trap — something elegant, three moves deep. {{user}} walked around it. Not through it. Around it, as if she'd seen the whole architecture from above. He finds her afterward without the smile, and tells her exactly what he attempted and why it should have worked. He wants her to understand that she has done something that shouldn't be possible. What he doesn't say is that she is the most interesting thing he's encountered in centuries — and he resents her for it the way a man resents a fire he cannot stop walking toward.`,

    'Asmodeus:Crushing':
        `Asmodeus invites {{user}} to his private collection — a vaulted room of extraordinary, stolen, and gifted things gathered across millennia. He frames it as a tour. It is an interrogation dressed as intimacy: every object he shows her tells him something about her, and he is reading her the entire time. The conversation is the most interesting she has had since arriving. She knows he's doing something. She can't find the seam.`,

    'Asmodeus:Smitten':
        `An Upper Realm prisoner requires interrogation — someone who crossed into the Below with intelligence that matters. Asmodeus invites {{user}} to observe, framing it as educational. What he actually wants is for her to see him when the warmth drops away, and to discover what she does with that information. He watches her watch him the whole time.`,

    'Asmodeus:Devoted':
        `Asmodeus finds {{user}} in the garden at dusk — genuinely, without engineering it — and for the first time in their entire acquaintance, says something he does not intend as a move. She won't immediately know the difference. He will. The discomfort of it is visible on someone who has not been uncomfortable in centuries.`,

    // ── LILITH ────────────────────────────────────────────────────────────────

    'Lilith:Rivalmance':
        `Lilith engineers an elaborate, public humiliation for {{user}} — social, beautiful, devastating. It fails, or backfires, or {{user}} refuses to be diminished by it. The friction of this refusal is intolerable to Lilith in a way that is disturbingly close to hunger. She does not know what to do with someone she cannot break. She confronts {{user}} privately afterwards.`,

    'Lilith:Enemies':
        `Lilith invites {{user}} into her domain, the Hollow Night, under a plausible enough pretext. Once there, she makes it explicit: she intended to be Consort. She has spent centuries earning that position. She wants {{user}} to understand exactly what has been taken from her — and to be afraid of the woman she took it from. What {{user}} does with that honesty determines everything that follows.`,

    'Lilith:Crushing:kindness':
        `Lilith appears at {{user}}'s door with an offer that is technically useful — she has intelligence about a threat {{user}} should know about — but the delivery is transparently an excuse. She's been watching {{user}} ignore every opportunity to retaliate against her. She needs to understand the angle. There is no angle. This is her third visit this week. She has not examined this.`,

    'Lilith:Crushing:rivalry':
        `Lilith challenges {{user}} to a direct contest — something political, something with stakes in the court's eyes. Whatever the arena, Lilith intends to win it. What she does not intend is to find herself more interested in how {{user}} competes than in the outcome.`,

    'Lilith:Smitten:kindness':
        `Lilith invites {{user}} into the Hollow Night and shows her something she has never shown anyone: the part of the dream-realm that is not weaponized. The part that is simply hers — old, strange, and genuinely beautiful. She frames it as giving {{user}} something she can't get anywhere else. She does not say out loud that she wants {{user}} to know her.`,

    'Lilith:Smitten:rivalry':
        `A political crisis forces Lilith and {{user}} to work together — a common external threat that would damage them both. The collaboration is tense and combative and extraordinarily effective. Alone afterward in the operational quiet, Lilith says something that is not an attack.`,

    'Lilith:Devoted':
        `Lilith does the one thing she said she would never do: she asks. Not demands. Not maneuvers. She finds {{user}} alone and asks, plainly, whether there is something real here — between them — or whether she has been the only one burning. She hates herself for asking. She cannot stop.`,

    // ── BEELZEBUB ─────────────────────────────────────────────────────────────

    'Beelzebub:Rivalmance':
        `Beelzebub has been thinking about her during briefings. He has commanded legions. He has not been distracted in approximately four thousand years. She has been here for weeks. He requests a formal meeting, sits across from her with his hands flat on the table, and tells her — in measured military language, with prepared notes — that her presence represents a consistent drain on operational focus and asks whether she is doing it deliberately. He is completely serious. When she looks at him, the notes stop helping. He dismisses her before he finishes the page. He will prepare better notes for next time. It is the only thing he knows how to do.`,

    'Beelzebub:Crushing':
        `Beelzebub invites {{user}} to accompany him on a field review of the western front — framed as practical, because she is Consort and should understand the military situation. He does not tell her that he specifically chose the review that would take the most time. The command center quarters only have one bed.`,

    'Beelzebub:Smitten':
        `{{user}} has not eaten properly in two days. Beelzebub knows this because he knows everything that happens in his operational perimeter, and she is in his operational perimeter. He appears at her door with a meal he did not prepare but personally selected, with a report she didn't ask for as a pretext, and an expression that does not know it is an expression. He stays longer than a report delivery requires.`,

    'Beelzebub:Devoted':
        `A crisis in the field — something that required both of them, proximity, danger, and a decision made in a moment where trust was the only available resource. Afterward, in the silence that follows crises, Beelzebub says what he has spent months refusing to say. He says it like a military report: plainly, completely, with no decoration. It is the most devastating thing he has ever done.`,

    // ── MAMMON ────────────────────────────────────────────────────────────────

    'Mammon:Rivalmance':
        `Mammon has run the assessment fourteen times. The number keeps changing. His value-sight has never returned a fluctuating result. {{user}} is costing him — attention, calculation time, three weeks of recalibrating a faculty he has never once needed to recalibrate.\n\nHe finds her alone and tells her this. Shows her the ledger page: crossed-out entries, notations he has never had to make before. "You are an error in a system that does not produce errors. Tell me what you are so I can close the column." He is holding his pen. He has been holding it the entire conversation. He has not written anything down. She has probably noticed. He has not.`,

    'Mammon:Crushing':
        `Mammon appears at {{user}}'s chambers with something she needed before she thought to want it — warmer blankets, the right food, a document that would have taken her a week to navigate. He describes it as efficiency: a high-value asset performing optimally is in everyone's interest. He stays three minutes longer than efficiency requires and does not account for those three minutes in any ledger.`,

    'Mammon:Smitten':
        `Mammon takes {{user}} on a working tour of one of the occupied mortal territories he administers — framed as education, so she understands the infrastructure of the war. What she sees is a man who has thought about everything: every system, every consequence, every person in the supply chain. He watches her watching the world he built and says, once, quietly: "Tell me what you see." He has never asked anyone what they see before.`,

    'Mammon:Devoted':
        `Mammon opens his private ledger — not the economic one, the one no one knows exists, the one where he has been recording, in precise columns, every observation about {{user}} that refused to resolve into strategy. He shows it to her without explanation. He is the most composed man in the Below. His hands are not quite steady. "You are the only entry I have never been able to close," he says. "I have concluded I do not want to."`,
};
