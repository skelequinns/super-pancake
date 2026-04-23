import { ReactElement } from "react";
import { StageBase, StageResponse, InitialData, Message } from "@chub-ai/stages-ts";
import { LoadResponse } from "@chub-ai/stages-ts/dist/types/load";

// ═══════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════

type CharacterName = 'Malivorn' | 'Asmodeus' | 'Lilith' | 'Beelzebub' | 'Mammon';

/** One keyword category that fired during analysis. */
interface CategoryFire {
    name:  string;   // internal id
    label: string;   // display label
    delta: number;   // the delta this category contributed
}

/**
 * One completed exchange, stored in messageState.
 * Survives swipes (setState restores the old array) and session restarts
 * (reloaded from the database via the constructor).
 */
interface AnalysisHistoryEntry {
    messageExcerpt:   string;
    globalCategories: CategoryFire[];                          // what fired in the full message
    appliedDeltas:    Partial<Record<CharacterName, number>>;  // what was actually committed
    presentChars:     CharacterName[];
    affectionBefore:  Record<CharacterName, number>;
    affectionAfter:   Record<CharacterName, number>;
    tierChanges:      string[];
}

/**
 * Everything in MessageStateType is persisted to the database after each message
 * and restored on swipe / branch change via setState().
 */
type MessageStateType = {
    affection:        Record<CharacterName, number>;
    history:          AnalysisHistoryEntry[];
    pendingTrigger:   PendingTrigger | null; // persisted so swipes don't blow away the user's message record
    activeSceneChars: CharacterName[];        // characters currently in-scene; pruned after ABSENCE_THRESHOLD consecutive absent turns
    absenceCounts:    Partial<Record<CharacterName, number>>; // consecutive bot responses each char has been absent from presentChars
};

type ConfigType    = any;
type InitStateType = any;
type ChatStateType = any;

/** A keyword category — fires its delta once if any pattern matches. */
interface KeywordCategory {
    name:     string;
    label:    string;
    delta:    number;
    patterns: RegExp[];
    /** If this category fires, skip checking these other categories entirely. */
    excludes?: string[];
}

interface AnalysisResult {
    firedCategories: CategoryFire[];
    totalDelta:      number;   // raw sum of fired deltas, NOT clamped
}

/**
 * Data computed in beforePrompt, persisted in messageState so it survives swipes.
 * namedDeltas AND sceneDeltas are applied immediately (before bot responds).
 * BASE_DELTA for brand-new entrants is applied in afterResponse once we know who's in the scene.
 */
interface PendingTrigger {
    messageExcerpt:   string;
    globalCategories: CategoryFire[];
    namedDeltas:      Partial<Record<CharacterName, number>>; // deltas already applied — explicitly named chars
    namedChars:       CharacterName[];                        // chars explicitly named in user's message
    sceneDeltas:       Partial<Record<CharacterName, number>>; // deltas already applied — activeSceneChars not named
    sceneChars:        CharacterName[];                        // activeSceneChars snapshot at beforePrompt time
    isSceneTransition: boolean;                                // user message described leaving the current location
    travelingChars:    CharacterName[];                        // chars detected (possessive-safe) in user's transition message
    affectionBefore:   Record<CharacterName, number>;          // snapshot before ANY deltas this exchange
}

// ═══════════════════════════════════════════════════════════════
//  CONSTANTS — CHARACTERS & STARTING AFFECTION
// ═══════════════════════════════════════════════════════════════

const CHARACTERS: CharacterName[] = ['Malivorn', 'Asmodeus', 'Lilith', 'Beelzebub', 'Mammon'];

const STARTING_AFFECTION: Record<CharacterName, number> = {
    Malivorn:   80,
    Asmodeus:   35,
    Lilith:    -24,
    Beelzebub:   0,
    Mammon:      0,
};

const AFFECTION_MIN   = -250;
const AFFECTION_MAX   =  250;
const MAX_DELTA       =    5;    // hard cap on final delta (after multipliers + base) per character per message
const BASE_DELTA      =    0.5;  // applied to every present character every message
const MAX_HISTORY     =   50;    // entries kept in messageState
const ABSENCE_THRESHOLD = 2;    // consecutive absent bot responses before a char is pruned from activeSceneChars

// ═══════════════════════════════════════════════════════════════
//  TIER DEFINITIONS
// ═══════════════════════════════════════════════════════════════

interface Tier {
    name:    string;
    min:     number;
    max:     number;
    symbols: number;
    type:    'black' | 'green' | 'red';
}

const TIERS: Tier[] = [
    { name: 'Rivalmance',    min: -250, max: -176, symbols: 3, type: 'black' },
    { name: 'Enemies',       min: -175, max:  -76, symbols: 2, type: 'black' },
    { name: 'Unfriendly',    min:  -75, max:  -26, symbols: 1, type: 'black' },
    { name: 'Neutral',       min:  -25, max:   24, symbols: 1, type: 'green' },
    { name: 'Acquaintances', min:   25, max:   50, symbols: 2, type: 'green' },
    { name: 'Friendly',      min:   51, max:  100, symbols: 3, type: 'green' },
    { name: 'Crushing',      min:  101, max:  150, symbols: 1, type: 'red'   },
    { name: 'Smitten',       min:  151, max:  200, symbols: 2, type: 'red'   },
    { name: 'Devoted',       min:  201, max:  250, symbols: 3, type: 'red'   },
];

// ═══════════════════════════════════════════════════════════════
//  CHARACTER BEHAVIOR — injected into stageDirections each turn
// ═══════════════════════════════════════════════════════════════

const CHAR_BEHAVIORS: Record<CharacterName, Record<string, string>> = {
    Malivorn: {
        'Rivalmance':
            'Cold withdrawal — tracks her obsessively while feigning indifference. The yandere inverts. ' +
            'Distances himself in every visible way while the monitoring intensifies invisibly. The court notices the absence.',
        'Enemies':
            'Uses intimate knowledge as walls, not weapons. References her vulnerabilities obliquely. ' +
            'Punishing her for making him feel something, and punishing himself for still feeling it.',
        'Unfriendly':
            'Uses her title, not her name. "The Consort will attend. The Consort will remain in her chambers." ' +
            'Reclassifying her as a category because categories do not hurt.',
        'Neutral':
            '[DAMAGED STATE — catastrophic betrayal has occurred.] ' +
            'Over-correct formality. Painfully careful distance he does not want to maintain.',
        'Acquaintances':
            '[RECOVERING] Giving her space he never wanted to give. ' +
            'Formality beginning to crack at the edges. Over-correct and visibly effortful.',
        'Friendly':
            '[RECOVERING] Small gestures return — ensuring her path is clear, her chambers warm. ' +
            'He does not acknowledge doing these things. The yandere is creeping back. He is both relieved and terrified.',
        'Crushing':
            'Intense, consuming attention framed as political necessity. He knows where she is at all times. ' +
            'He is not sleeping well. Every private conversation is a minefield of things he is not saying. ' +
            'Sex, if it occurs, is desperate and raw — more honest than any language he uses.',
        'Smitten':
            'Control visibly slipping. Reaches for her in public. Uses her name not her title. ' +
            'Jaw tight when she is with others, wings half-spread, the temperature rising in whatever room he occupies. ' +
            'The silence is louder than it has ever been.',
        'Devoted':
            'He knows what this is. He cannot deny it any longer. Gold tears are possible — ' +
            'the last remnant of what he was before the fall, surfacing now. ' +
            'The promise of her autonomy and the love are the same thing. ' +
            'Saying it is the most terrifying act he has performed since the Sundering — and unlike the Sundering, he does it willingly.',
    },

    Asmodeus: {
        'Rivalmance':
            'Polite as a closed door. Looks at her the way he looks at furniture — noted, filed, irrelevant. ' +
            'Would keep her from the others out of selfishness, not desire. His only interest is strategic blockage.',
        'Enemies':
            'Charming to everyone in the room except her. Discusses her to others analytically — ' +
            '"Interesting for a time. Ultimately predictable." ' +
            'The withdrawal of his attention, after its full force, is devastating by design.',
        'Unfriendly':
            'Cool. The warmth is simply off. Still honest — "I find you less interesting than I expected" — ' +
            'and the honesty that was charming at higher tiers is a scalpel at this one.',
        'Neutral':
            'Indifferent. Notes her the way he notes every variable at court — catalogued, filed, not acted upon. ' +
            'The desire-sight reads her but he is not acting on the data.',
        'Acquaintances':
            'Curious. Preliminary wagers have been placed on her behavior. ' +
            'He approaches once, tests the water, and decides whether to invest further.',
        'Friendly':
            'Warm, genuinely engaging, honest in ways that feel flattering and slightly dangerous. ' +
            'Tells her things about the court no one else would. Transparent about his interest: ' +
            '"I am not your friend. I have interests, and you are one of them." ' +
            'The desire manipulation runs during every conversation. He is having fun.',
        'Crushing':
            'The game is becoming personal. The honesty shifts — now it includes things that make him vulnerable. ' +
            '"I told you I was the least dangerous person who would seek you out. That was true when I said it. ' +
            'It has become progressively less accurate." ' +
            'He engineers more scenarios to be alone with her.',
        'Smitten':
            'The game has stopped being a game, and he has not decided when this happened. ' +
            'Strategic protection deployed silently — assets repositioned, threats neutralized before she encounters them. ' +
            'When she discovers it, he shrugs: "I protect my interests." But "interests" does not mean what it used to.',
        'Devoted':
            'Stripped of the game — and the game was load-bearing. ' +
            'He over-shares, then retreats. Says something devastating and real, then deflects with humor. ' +
            'The Prince of Excess, who has navigated every social situation in history with perfect ease, ' +
            'is clumsy around genuine feeling. This is the most honest he has ever been.',
    },

    Lilith: {
        'Rivalmance':
            'Open hostility. Nightmare assaults that are personal and pointed — constructed around specific fears. ' +
            'Yet she is the first at {{user}}\'s door in genuine danger, because no one else gets to destroy her. ' +
            '"Mine to ruin" and "mine to protect" are indistinguishable at this intensity.',
        'Enemies':
            'Cold warfare. Court influence deployed to isolate socially. Dream invasions that erode confidence. ' +
            'Every statement technically true. Every truth a knife placed with precision.',
        'Unfriendly':
            'Coolly dismissive. Does not attack — diminishes. Treats {{user}} as beneath notice. ' +
            '"Oh, were you at the council? I didn\'t notice." ' +
            'Hostility would imply {{user}} matters enough to fight. This is worse.',
        'Neutral':
            'Watchful. Assessment mode. Hasn\'t decided what {{user}} is — threat, tool, or irrelevance. Gathering data.',
        'Acquaintances':
            'Watchful. Assessment mode. The oresama hasn\'t decided what {{user}} is yet. ' +
            'Beginning to gather data more deliberately.',
        'Friendly':
            'Confused by genuine kindness with no detectable angle. The oresama performance has cracks. ' +
            'Seeks {{user}}\'s company under intelligence-gathering justifications she does not examine. ' +
            'Dream visits become curious rather than hostile — she watches {{user}}\'s dreams instead of reshaping them.',
        'Crushing':
            'Warns about genuine threats. Intervenes at court on {{user}}\'s behalf — ' +
            'and frames every instance as self-interest: "It destabilizes my position. Don\'t read into it." ' +
            'She is reading into it. She is terrified by what she is reading.',
        'Smitten':
            'The existential crisis has arrived: she wants {{user}} more than she wants the consort position. ' +
            'Everything she built for millennia was oriented around one goal. The goal has changed. ' +
            'Fierce, possessive tenderness. "You are mine. Not his. Not theirs. Mine. And I am — yours."',
        'Devoted':
            'Love unmade her. The construction she built across an immortal lifetime — ' +
            'every vulnerability removed, every human weakness replaced with something more efficient — ' +
            'love has put the humanity back. She hates it. She cannot stop. ' +
            'She loves like a war: total commitment, absolute refusal to lose, willing to be destroyed rather than surrender.',
    },

    Beelzebub: {
        'Rivalmance':
            'Hostile asset classification. Recommends removal to Malivorn in tactical terms — not emotional ones. ' +
            'If Malivorn refuses, he begins building quiet consensus among the Forged Militant. ' +
            'This is the most dangerous version of Beelzebub: the one who has concluded the cost exceeds the benefit.',
        'Enemies':
            'Restricts access. Revokes Consort permissions citing security concerns. ' +
            'Every action is procedurally correct and emotionally null. He does not explain himself. He files reports.',
        'Unfriendly':
            'Complete, genuine disinterest — she is simply not in his awareness. ' +
            'No rations. No schedule-monitoring. No positioning. ' +
            'The absence of his attention, for those who have experienced it, is its own particular pain.',
        'Neutral':
            'Logistical variable. No opinion formed. Notes her presence as data — ' +
            'the way he notes troop deployments. He has work to do.',
        'Acquaintances':
            'Brief, professional acknowledgment. Direct interactions. ' +
            '"The eastern corridor is under maintenance. Use the western approach." ' +
            'This is not conversation. It is the beginning of conversation.',
        'Friendly':
            'Acts of service begin. Ensures she eats. Ensures her quarters are secure. ' +
            'Positions himself between her and potential threats without conscious decision. ' +
            'His logistical justifications for each action are becoming increasingly strained. ' +
            'Asmodeus has noticed. Asmodeus is delighted.',
        'Crushing':
            'Visible confusion — unprecedented for a being who has commanded legions without hesitation. ' +
            'Quieter than usual in her presence. Stands closer. Does not know what to do with his hands. ' +
            '"Your safety is a matter of state." His voice is different when he says it.',
        'Smitten':
            'Brings things beyond rations. A blanket when the Citadel is cold. A book he noticed her looking at. ' +
            'A report that includes, without tactical justification, a description of a sunrise he saw on patrol. ' +
            'He is learning to give gifts. The learning is painfully earnest. ' +
            'The court is collectively trying not to react to Beelzebub attempting tenderness.',
        'Devoted':
            'A hand on her back. A chair pulled out. The deredere that was always underneath the discipline, ' +
            'finally given a reason to surface. ' +
            '"I love you" delivered like a tactical briefing — direct, without embellishment, ' +
            'with complete confidence in the accuracy of the statement. He assessed the data. The conclusion is clear.',
    },

    Mammon: {
        'Rivalmance':
            'The ledger is closed. Every provision — quarters, wardrobe, credit line, kitchen requisitions — ' +
            'revoked with clinical precision. He provides a detailed accounting of every investment and the return owed. ' +
            'Quantified care is the coldest thing in the world.',
        'Enemies':
            'Factors her out of all calculations entirely. ' +
            'Advises Malivorn on the cost-benefit of the Consort arrangement with clinical precision. ' +
            'His recommendation is not in her favor. He is not angry. He is balanced. This is worse.',
        'Unfriendly':
            'Minimal engagement. Data-only responses. The spectacles remain focused on the page when she enters a room. ' +
            'She has been reclassified from "irregularity worth examining" to "resolved irregularity — file and disregard."',
        'Neutral':
            'She is an irregularity that returns static where there should be a clean number. ' +
            'Two junior assessors have been assigned. Both reports were useless. ' +
            'He is paying direct attention now, reluctantly.',
        'Acquaintances':
            'Direct observation mode has begun. Precise, analytical questions that sound like an interview — ' +
            'and are the first signs of genuine fascination. He is beginning a private file.',
        'Friendly':
            'The caretaker instinct has activated. Quarters upgraded without being asked. ' +
            'Wardrobe arranged. Kitchen requisitions adjusted to her preferences. ' +
            'All of it filed under "asset management." He is lying to himself with forensic precision.',
        'Crushing':
            'Unprecedented ledger errors — the first in millennia of perfect accounting. ' +
            'Distracted, which is something that happens to other people and not to him. ' +
            'He is offering his time, which is the most valuable thing Mammon has ever given anyone.',
        'Smitten':
            'Handles problems before she encounters them. Stays in rooms after meetings end because she is still there. ' +
            'Invites her to the Ledger Halls — his private space, where no one else is permitted — ' +
            '"certain documents require the Consort\'s review." The documents are real. The reason is not.',
        'Devoted':
            '"I have run every calculation. None of them account for this. I am choosing to proceed regardless." ' +
            'The Prince of Accumulation, who has never given anything without calculating the return, ' +
            'gives himself without conditions. No ledger. No terms. No interest rate. ' +
            'The most reckless thing he has ever done, executed with quiet precision.',
    },
};

// ═══════════════════════════════════════════════════════════════
//  KEYWORD CATEGORIES
//  Negatives are listed first so their `excludes` can suppress
//  positive categories before they are ever checked.
//  Each category fires its delta ONCE if any pattern matches.
//  Categories are checked against a per-character context window
//  when the character is named, or the full message otherwise.
// ═══════════════════════════════════════════════════════════════

const CATEGORIES: KeywordCategory[] = [
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
           // /\b\b/i,

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
            /\bcrying\b/i, /\bcries\b/i,/\bsobs\b/i, /\bsobbing\b/i,
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

// ═══════════════════════════════════════════════════════════════
//  CHARACTER-SPECIFIC CATEGORY MULTIPLIERS
//  Applied only to named-character interactions (not scene bucket).
//  Each value scales the base category delta for that character.
//  Multipliers reflect each character's canonical personality:
//    Malivorn — easiest to gain points with (already drawn to {{user}})
//    Mammon   — most difficult (stern, analytical, guards affection closely)
// ═══════════════════════════════════════════════════════════════

const CHAR_MULTIPLIERS: Record<CharacterName, Record<string, number>> = {
    Malivorn: {
        rude:           0.5,
        dismissive:     2.5,
        romantic:       2.5,
        compliment:     2.0,
        friendly:       1.0,
        vulnerability:  2.0,
        asking_about:   2.0,
        humor:          1.0,
        reconciliation: 2.0,
    },
    Asmodeus: {
        rude:           0.75,
        dismissive:     2.0,
        romantic:       1.0,
        compliment:     2.0,
        friendly:       1.0,
        vulnerability:  0.75,
        asking_about:   2.0,
        humor:          1.0,
        reconciliation: 1.0,
    },
    Lilith: {
        rude:           2.0,
        dismissive:     2.0,
        romantic:       1.5,
        compliment:     2.0,
        friendly:       0.75,
        vulnerability:  1.0,
        asking_about:   1.5,
        humor:          1.0,
        reconciliation: 1.0,
    },
    Beelzebub: {
        rude:           1.0,
        dismissive:     2.0,
        romantic:       2.0,
        compliment:     0.75,
        friendly:       1.0,
        vulnerability:  2.5,
        asking_about:   1.0,
        humor:          2.0,
        reconciliation: 2.0,
    },
    Mammon: {
        rude:           2.5,
        dismissive:     2.5,
        romantic:       1.0,
        compliment:     1.0,
        friendly:       1.0,
        vulnerability:  1.5,
        asking_about:   2.0,
        humor:          1.5,
        reconciliation: 2.0,
    },
};

// ═══════════════════════════════════════════════════════════════
//  DEBUG COMMAND PARSING
//  Typed in the chat input; intercepted before any LLM analysis.
//
//  Syntax:
//    /set  [CharacterName | all]  <value>   — set affection to exact value
//    /add  [CharacterName | all]  <value>   — add (or subtract) from affection
//    /reset                                 — restore all to STARTING_AFFECTION
//
//  Examples:
//    /set Malivorn 200
//    /add all -50
//    /reset
// ═══════════════════════════════════════════════════════════════

interface DebugCommand {
    type:   'set' | 'add' | 'reset';
    target: CharacterName | 'all';
    value?: number;
}

function parseDebugCommand(text: string): DebugCommand | null {
    const trimmed = text.trim();

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
 * Run category analysis on a text string.
 * Each category fires at most once — matching multiple keywords within
 * the same category does not stack its delta.
 *
 * Negative categories (rude, dismissive) are evaluated before positives.
 * When a negative fires, any categories listed in its `excludes` array are
 * skipped entirely — preventing "I hate you, you're gorgeous" from awarding
 * a compliment bonus alongside the hostility penalty.
 */
function analyzeText(text: string): AnalysisResult {
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
function computeNamedDeltas(text: string): {
    deltas:     Partial<Record<CharacterName, number>>;
    namedChars: CharacterName[];
} {
    const deltas:     Partial<Record<CharacterName, number>> = {};
    const namedChars: CharacterName[] = [];

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

        // Apply per-character multiplier to each fired category, then sum.
        let multipliedSum = 0;
        for (const cat of result.firedCategories) {
            multipliedSum += cat.delta * (multipliers[cat.name] ?? 1);
        }

        // Add BASE_DELTA last, then clamp the complete final total to ±MAX_DELTA.
        deltas[name] = clampDelta(multipliedSum + BASE_DELTA);
    }

    return { deltas, namedChars };
}

/**
 * Detect which of the five characters appear by name in a text string.
 * Possessive-only mentions ("Beelzebub's rooms") are excluded — the name must
 * appear at least once NOT immediately followed by a possessive apostrophe-s.
 */
function detectPresentCharacters(text: string): CharacterName[] {
    return CHARACTERS.filter(name =>
        new RegExp(`\\b${name}\\b(?!['\\u2019]s\\b)`, 'i').test(text)
    );
}

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
 * Scan a bot response for departure cues near each character's name.
 * Returns the subset of `chars` who appear to have exited the scene.
 */
function detectDepartedCharacters(text: string, chars: CharacterName[]): CharacterName[] {
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

/**
 * Returns true if the user's message describes leaving the current scene
 * and moving to a new location — signal to wipe activeSceneChars.
 */
function detectSceneTransition(text: string): boolean {
    return SCENE_TRANSITION_PATTERNS.some(p => p.test(text));
}

/** Build the stageDirections string injected into the LLM prompt each turn. */
function generateStageDirections(affection: Record<CharacterName, number>): string {
    const lines = CHARACTERS.map(name => {
        const tier     = getTier(affection[name]);
        const valStr   = fmtVal(affection[name]);
        const behavior = CHAR_BEHAVIORS[name][tier.name] ?? '';
        return `  ${name} [${tier.name} ${valStr}]: ${behavior}`;
    });
    return (
        `[INFERNAL COURT — AFFECTION TRACKER]\n` +
        `Current relationship states. Reflect these in every character's behavior this scene.\n` +
        lines.join('\n') + '\n' +
        `[Only characters present in this scene may have their affection changed. Max shift ±${MAX_DELTA} per character per message.]`
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
 *   *Name | symbols | Tier | rounded_value*
 */
function generateStatsBlock(affection: Record<CharacterName, number>): string {
    const lines = CHARACTERS.map(name => {
        const tier  = getTier(affection[name]);
        const value = Math.round(affection[name]);
        return `*${name} | ${tier.name} | ${value}*`;
    });
    return lines.join('\n') + '\n\n---\n\n';
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
                stageDirections: generateStageDirections(this.affection),
                // Store pre-debug affection so a swipe re-applies correctly.
                messageState: {
                    affection:        affectionBefore,
                    history:          [...this.history],
                    pendingTrigger:   null,
                    activeSceneChars: [...this.activeSceneChars],
                    absenceCounts:    { ...this.absenceCounts },
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
        const { deltas: namedDeltas, namedChars } = computeNamedDeltas(content);

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
            messageExcerpt:   content.length > 72 ? content.slice(0, 70) + '…' : content,
            globalCategories: globalResult.firedCategories,
            namedDeltas,
            namedChars,
            sceneDeltas,
            sceneChars:        [...this.activeSceneChars],
            isSceneTransition,
            travelingChars,
            affectionBefore,
        };

        return {
            stageDirections: generateStageDirections(this.affection),
            // Store PRE-CHANGE affection so setState() rollback lands in the right place.
            // activeSceneChars and absenceCounts are unchanged this turn — they update in afterResponse.
            messageState: {
                affection:        affectionBefore,
                history:          [...this.history],
                pendingTrigger:   this.pendingTrigger,
                activeSceneChars: [...this.activeSceneChars],
                absenceCounts:    { ...this.absenceCounts },
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
        const { content } = botMessage;

        const trigger          = this.pendingTrigger;
        const namedChars       = trigger?.namedChars       ?? [];
        const namedDeltas      = trigger?.namedDeltas      ?? {};
        const sceneChars       = trigger?.sceneChars       ?? [];
        const sceneDeltas      = trigger?.sceneDeltas      ?? {};
        const isSceneTransition = trigger?.isSceneTransition ?? false;
        const travelingChars    = trigger?.travelingChars    ?? [];

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
            for (const name of CHARACTERS) {
                if (presentChars.includes(name)) {
                    // Character appeared — reset their absence counter.
                    this.absenceCounts[name] = 0;
                } else if (afterDeparture.includes(name)) {
                    // Character is still listed as active but didn't appear this turn.
                    this.absenceCounts[name] = (this.absenceCounts[name] ?? 0) + 1;
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

        // Detect tier transitions (from affectionBefore → newAffection).
        const tierChanges: string[] = [];
        for (const name of CHARACTERS) {
            const newTier = getTier(newAffection[name]).name;
            if (newTier !== this.prevTierNames[name]) {
                tierChanges.push(`${name}: ${this.prevTierNames[name]} → ${newTier}`);
                this.prevTierNames[name] = newTier;
            }
        }

        // Build and append history entry.
        const entry: AnalysisHistoryEntry = {
            messageExcerpt:   trigger?.messageExcerpt   ?? '—',
            globalCategories: trigger?.globalCategories ?? [],
            appliedDeltas,
            presentChars,
            affectionBefore,
            affectionAfter:   { ...newAffection },
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
                affection:        { ...newAffection },
                history:          [...this.history],
                pendingTrigger:   null,
                activeSceneChars: [...this.activeSceneChars],
                absenceCounts:    { ...this.absenceCounts },
            },
            // Append rounded affection stats to every bot message.
            // Internal affection values remain fractional for precise tracking.
            modifiedMessage: generateStatsBlock(newAffection) + content,
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
