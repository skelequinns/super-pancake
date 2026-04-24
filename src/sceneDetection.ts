// ═══════════════════════════════════════════════════════════════
//  SCENE DETECTION
//  Stateless helpers for detecting character presence, departures,
//  and scene transitions from message text.
// ═══════════════════════════════════════════════════════════════

import { CharacterName, CHARACTERS } from './constants';

// ── Patterns ─────────────────────────────────────────────────────────────────

/**
 * Departure cues — patterns checked in a context window around each character's name.
 * A character is only considered departed if their name appears AND a nearby cue fires.
 *
 * NOTE: "left" is NOT included in the bare-verb list because it also appears as a
 * directional adjective ("Malivorn's left", "his left eyebrow") and would fire false
 * positives. Instead, two specific sub-patterns cover the verb usage only.
 */
const DEPARTURE_PATTERNS: RegExp[] = [
    /\b(?:departs?|departed|exits?|exited|withdrew|retreated|vanished|dismissed)\b/i,
    // "left" as a departure verb — requires either a location object or a manner adverb.
    /\bleft (?:the (?:room|chamber|hall(?:way)?|scene|throne room|study|corridor|gallery|courtyard|area|citadel)|without|abruptly|quietly|suddenly|silently)\b/i,
    // "he/she/they left" — subject-verb form with no location required.
    /\b(?:he|she|they|it)\s+left\b/i,
    /\bwalks? (?:away|out|toward the door|to the door)\b/i,
    /\bturns? and (?:leaves?|left|goes?|went)\b/i,
    /\bleaves? (?:the (?:room|chamber|hall|scene|throne room|study|corridor)|without)\b/i,
    /\bno longer (?:in|present|here|with)\b/i,
    /\bis gone\b/i,
];

/**
 * Scene-transition patterns checked against the user's message.
 * Any match means the player has moved to a new location; activeSceneChars
 * should be wiped and rebuilt from the bot's response rather than merged.
 */
const SCENE_TRANSITION_PATTERNS: RegExp[] = [
    // Leading / escorting away from somewhere
    /\b(?:leads?|takes?|escorts?|guides?|walks?) (?:her|him|them|me|us) (?:from|out of|away from)\b/i,
    // Explicit departure from a named space
    /\b(?:leaves?|left|exits?|exited|departs?|departed) (?:the |a )?(?:room|chamber|hall(?:way)?|throne room|scene|corridor|courtyard|study|gallery|citadel)\b/i,
    // "from the [location]" — leaving a named space
    /\bfrom the (?:throne room|great hall|main hall|audience chamber|council chamber|chamber|room|hall(?:way)?|corridor|gallery|courtyard)\b/i,
    // Moving into a clearly new location
    /\binto (?:the |a )(?:hall(?:way)?|corridor|chamber|passage|wing|gallery|courtyard|citadel|keep|anteroom)\b/i,
    // Following someone out
    /\b(?:follows?|followed) (?:him|her|them) (?:out|away|through the door|into)\b/i,
    // Generic walk-away
    /\bthey (?:leave|left|exit|exited|walk away|walked away)\b/i,
    /\bwalks? (?:her|him|them|me|us) (?:out|away|through)\b/i,
    /\bsteps? (?:out|through|away) (?:of|from|into)\b/i,
];

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Detect which of the five characters appear by name in a text string.
 * Possessive-only mentions ("Beelzebub's rooms") are excluded — the name must
 * appear at least once NOT immediately followed by a possessive apostrophe-s.
 *
 * Used for: stats block display, affection scoring, scene membership.
 */
export function detectPresentCharacters(text: string): CharacterName[] {
    return CHARACTERS.filter(name =>
        new RegExp(`\\b${name}\\b(?!['\\u2019]s\\b)`, 'i').test(text)
    );
}

/**
 * Detect which characters are mentioned anywhere in a text string,
 * including possessive references ("Beelzebub's chair", "Mammon's pen").
 *
 * Used for: absence-count resets ONLY.
 * A possessive mention proves the character is still in the scene —
 * the narrative simply chose to reference them through their belongings or attributes.
 * This prevents characters from being incorrectly pruned when they appear
 * exclusively in possessive form across consecutive turns.
 */
export function detectMentionedCharacters(text: string): CharacterName[] {
    return CHARACTERS.filter(name =>
        new RegExp(`\\b${name}\\b`, 'i').test(text)
    );
}

/**
 * Scan a bot response for departure cues near each character's name.
 * Returns the subset of `chars` who appear to have exited the scene.
 */
export function detectDepartedCharacters(text: string, chars: CharacterName[]): CharacterName[] {
    const departed: CharacterName[] = [];
    const WINDOW = 180;

    for (const name of chars) {
        const re = new RegExp(`\\b${name}\\b`, 'gi');
        const matches = [...text.matchAll(re)];
        if (matches.length === 0) continue; // not mentioned → can't confirm departure

        for (const match of matches) {
            const start   = Math.max(0, match.index! - WINDOW);
            const end     = Math.min(text.length, match.index! + name.length + WINDOW);
            const context = text.slice(start, end);
            if (DEPARTURE_PATTERNS.some(p => p.test(context))) {
                departed.push(name);
                break;
            }
        }
    }
    return departed;
}

/**
 * Returns true if the user's message describes leaving the current scene
 * and moving to a new location — signal to wipe activeSceneChars.
 */
export function detectSceneTransition(text: string): boolean {
    return SCENE_TRANSITION_PATTERNS.some(p => p.test(text));
}
