import { Stage } from "./Stage";
import { useEffect, useState } from "react";
import { DEFAULT_INITIAL, DEFAULT_MESSAGE, StageBase, InitialData } from "@chub-ai/stages-ts";

// Modify this JSON to include whatever character/user information you want to test.
import InitData from './assets/test-init.json';

export interface TestStageRunnerProps<
    StageType extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType>,
    InitStateType, ChatStateType, MessageStateType, ConfigType
> {
    factory: (data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) => StageType;
}

// ─────────────────────────────────────────────────────────────
//  TEST EXCHANGES
//  Each entry is one full round-trip: user message + bot response.
//  Bot responses name the characters who are "in the scene" —
//  only those characters have affection changed.
// ─────────────────────────────────────────────────────────────
const TEST_EXCHANGES = [
    {
        label: '1 · Romantic address to Asmodeus (expect: Asmodeus +2.25, Malivorn +0.25)',
        user:  'I love you, Asmodeus. You are magnificent.',
        bot:   'Asmodeus let the silence stretch, copper eyes warm in a way that had never quite meant warmth. ' +
               '"I know," he said. Malivorn, across the room, said nothing. His jaw was tight.',
    },
    {
        label: '2 · Pure vulnerability, no name (expect: base +0.25 to all present in bot response)',
        user:  "I'm scared. I don't know what to do. I feel completely alone.",
        bot:   'Beelzebub set down his field report. He crossed the room without being asked and stood between her and the door. ' +
               'Mammon looked up from his ledger, and for once did not look back down.',
    },
    {
        label: '3 · Curiosity directed at Malivorn (expect: Malivorn +1.25)',
        user:  'Malivorn — do you ever regret it? What do you think the Sundering actually cost you?',
        bot:   'Malivorn was silent long enough that it became its own answer. ' +
               'When he finally spoke, his voice was careful. "Everything. And I would do it again."',
    },
    {
        label: '4 · Hostile rejection of Lilith (expect: Lilith -1.75, Asmodeus +0.25)',
        user:  "You are a monster, Lilith. I don't trust you. I hate what you did.",
        bot:   "Lilith's smile did not move. \"Of course you do,\" she said. " +
               'Asmodeus, from the doorway, watched with the focused attention of someone placing a bet.',
    },
    {
        label: '5 · Playful & asking about Beelzebub (expect: Beelzebub +2.25)',
        user:  'Beelzebub, do you ever laugh? What do you find funny? I want to know.',
        bot:   'Beelzebub considered the question with the same gravity he gave troop movements. ' +
               '"Inefficiency," he said, after a pause. "When it happens to someone else." ' +
               'It took her a moment to realise it was a joke.',
    },
    {
        label: '6 · Category-fires-once: many compliment words for Mammon (expect: Mammon +1.25)',
        user:  'Mammon, you are brilliant, elegant, remarkably perceptive, and deeply impressive.',
        bot:   'Mammon adjusted his spectacles. He said nothing for three seconds, which was, by his accounting, a very long time.',
    },
    {
        label: '7 · Neutral message (no keywords, expect: base +0.25 to Malivorn only)',
        user:  'I walk to the window and look out at the amber sky.',
        bot:   'The Citadel was quiet at this hour. Malivorn watched her from across the room.',
    },
    {
        label: '8 · Swipe simulation — setState called with rolled-back state',
        user:  '(swipe — this exchange is simulated as a setState call, not a new message)',
        bot:   '',
    },
];

export const TestStageRunner = <
    StageType extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType>,
    InitStateType, ChatStateType, MessageStateType, ConfigType
>({ factory }: TestStageRunnerProps<StageType, InitStateType, ChatStateType, MessageStateType, ConfigType>) => {

    // @ts-ignore
    const [stage] = useState(new Stage({ ...DEFAULT_INITIAL, ...InitData }));
    const [status, setStatus] = useState('Running tests — see DevTools console (F12)…');

    function refresh() {}

    function addLog(msg: string) {
        console.log(msg);
    }

    function assert(label: string, pass: boolean) {
        addLog(`  ${pass ? '✓' : '❌'} ${label}`);
        return pass;
    }

    async function delay(ms: number) {
        return new Promise(r => setTimeout(r, ms));
    }

    async function runExchange(userContent: string, botContent: string, label: string) {
        addLog(`▶ ${label}`);

        const beforeRes = await stage.beforePrompt({
            ...DEFAULT_MESSAGE,
            anonymizedId: '0',
            content:      userContent,
            isBot:        false,
        });
        if (beforeRes.error) addLog(`  ⚠ beforePrompt error: ${beforeRes.error}`);
        refresh();

        await delay(600);

        const afterRes = await stage.afterResponse({
            ...DEFAULT_MESSAGE,
            anonymizedId: '1',
            content:      botContent,
            isBot:        true,
        });
        if (afterRes.error)         addLog(`  ⚠ afterResponse error: ${afterRes.error}`);
        if (afterRes.systemMessage) addLog(`  🔔 ${afterRes.systemMessage}`);

        refresh();
        await delay(1200);
    }

    async function debugSet(char: string, value: number) {
        await stage.beforePrompt({
            ...DEFAULT_MESSAGE,
            anonymizedId: '0',
            content:      `/set ${char} ${value}`,
            isBot:        false,
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  MILESTONE SMOKE TESTS
    //  Verifies that milestone prompts are:
    //    1. Queued in pendingMilestonePrompt after a tier crossing
    //    2. Injected into stageDirections on the NEXT beforePrompt call
    //    3. Consumed (cleared) after injection
    //    4. Not re-fired on a second crossing of the same boundary
    //    5. Keyed correctly in firedMilestones
    //    6. Lilith's path (kindness vs rivalry) resolves correctly
    // ─────────────────────────────────────────────────────────────

    async function runMilestoneTests() {
        addLog('');
        addLog('━━ MILESTONE INJECTION SMOKE TESTS ━━━━━━━━━━━━━━━━━━━━━━━━');
        addLog('');

        // ── M1: Malivorn crosses Friendly → Crushing ───────────────────────
        addLog('▶ M1 · Malivorn crosses Friendly → Crushing');
        addLog('    (expect: pendingMilestonePrompt set, key "Malivorn:Crushing" in firedMilestones)');

        await debugSet('Malivorn', 99);   // just below Crushing boundary (101)
        addLog(`    Malivorn positioned at: ${Math.round(stage.affection['Malivorn'])}`);

        // Romantic message — should push Malivorn to ~104 (Crushing)
        const beforeM1 = await stage.beforePrompt({
            ...DEFAULT_MESSAGE, anonymizedId: '0',
            content: 'I love you, Malivorn. You are the only one I want.',
            isBot: false,
        });
        assert('stageDirections present before tier cross', !!beforeM1.stageDirections);
        assert('no milestone injected yet (fires next turn, not this one)',
            !(beforeM1.stageDirections?.includes('MILESTONE EVENT') ?? false));

        await stage.afterResponse({
            ...DEFAULT_MESSAGE, anonymizedId: '1',
            content: 'Malivorn was very still. Something in his expression shifted — not softened, but opened.',
            isBot: true,
        });

        addLog(`    Malivorn affection after cross: ${Math.round(stage.affection['Malivorn'])}`);
        assert('Malivorn crossed into Crushing (≥ 101)',
            stage.affection['Malivorn'] >= 101);
        assert('pendingMilestonePrompt is set',
            stage.pendingMilestonePrompt !== null);
        assert('"Malivorn:Crushing" registered in firedMilestones',
            stage.firedMilestones.has('Malivorn:Crushing'));
        assert('prompt text contains character name',
            stage.pendingMilestonePrompt?.includes('Malivorn') ?? false);
        assert('prompt text contains "war room" (scene identifier)',
            stage.pendingMilestonePrompt?.includes('war room') ?? false);

        refresh();
        await delay(800);

        // ── M2: Next beforePrompt injects the milestone into stageDirections ──
        addLog('');
        addLog('▶ M2 · Next beforePrompt should inject milestone into stageDirections');
        addLog('    (the LLM receives the scene prompt this turn)');

        const beforeM2 = await stage.beforePrompt({
            ...DEFAULT_MESSAGE, anonymizedId: '0',
            content: 'I follow Malivorn out of the throne room.',
            isBot: false,
        });

        const dirs = beforeM2.stageDirections ?? '';
        assert('stageDirections contains [MILESTONE EVENT] block',
            dirs.includes('MILESTONE EVENT'));
        assert('milestone block names MALIVORN',
            dirs.includes('MALIVORN'));
        assert('milestone block names CRUSHING',
            dirs.includes('CRUSHING'));
        assert('milestone block contains scene prompt text ("war room")',
            dirs.includes('war room'));
        assert('milestone block contains [END MILESTONE SCENE]',
            dirs.includes('END MILESTONE SCENE'));
        assert('pendingMilestonePrompt cleared after injection',
            stage.pendingMilestonePrompt === null);

        // Log a snippet so we can eyeball it
        const milestoneStart = dirs.indexOf('[MILESTONE EVENT');
        const milestoneEnd   = dirs.indexOf('[END MILESTONE SCENE]') + '[END MILESTONE SCENE]'.length;
        if (milestoneStart >= 0 && milestoneEnd > milestoneStart) {
            addLog('');
            addLog('    ── Injected block (first 200 chars) ──');
            addLog(`    ${dirs.slice(milestoneStart, milestoneStart + 200)}…`);
            addLog('    ───────────────────────────────────────');
        }

        await stage.afterResponse({
            ...DEFAULT_MESSAGE, anonymizedId: '1',
            content: 'Malivorn led her through the war room without explaining why she was there.',
            isBot: true,
        });

        refresh();
        await delay(800);

        // ── M3: Re-crossing the same boundary must NOT re-fire ─────────────
        addLog('');
        addLog('▶ M3 · Re-cross Friendly → Crushing (first-time-only guard)');
        addLog('    (expect: pendingMilestonePrompt stays null)');

        await debugSet('Malivorn', 99);

        await stage.beforePrompt({
            ...DEFAULT_MESSAGE, anonymizedId: '0',
            content: 'I love you, Malivorn.',
            isBot: false,
        });
        await stage.afterResponse({
            ...DEFAULT_MESSAGE, anonymizedId: '1',
            content: 'Malivorn said nothing. His jaw was tight.',
            isBot: true,
        });

        assert('pendingMilestonePrompt is null (no re-fire)',
            stage.pendingMilestonePrompt === null);
        assert('"Malivorn:Crushing" still in firedMilestones (key preserved)',
            stage.firedMilestones.has('Malivorn:Crushing'));

        refresh();
        await delay(800);

        // ── M4: Different character — Mammon crosses into Crushing ──────────
        addLog('');
        addLog('▶ M4 · Mammon crosses into Crushing');
        addLog('    (expect: "Mammon:Crushing" keyed, separate from Malivorn milestone)');

        await debugSet('Mammon', 99);
        addLog(`    Mammon positioned at: ${Math.round(stage.affection['Mammon'])}`);

        await stage.beforePrompt({
            ...DEFAULT_MESSAGE, anonymizedId: '0',
            content: 'Mammon, you are brilliant. I want to know more about you.',
            isBot: false,
        });
        await stage.afterResponse({
            ...DEFAULT_MESSAGE, anonymizedId: '1',
            content: 'Mammon set his pen down. He had not planned to answer. He answered anyway.',
            isBot: true,
        });

        addLog(`    Mammon affection after cross: ${Math.round(stage.affection['Mammon'])}`);
        assert('Mammon crossed into Crushing (≥ 101)',
            stage.affection['Mammon'] >= 101);
        assert('pendingMilestonePrompt is set',
            stage.pendingMilestonePrompt !== null);
        assert('"Mammon:Crushing" in firedMilestones',
            stage.firedMilestones.has('Mammon:Crushing'));
        assert('"Malivorn:Crushing" still present (no collision)',
            stage.firedMilestones.has('Malivorn:Crushing'));
        assert('prompt contains Mammon scene text ("efficiency")',
            stage.pendingMilestonePrompt?.includes('efficiency') ?? false);

        refresh();
        await delay(800);

        // ── M5: Lilith kindness path ─────────────────────────────────────────
        addLog('');
        addLog('▶ M5 · Lilith crosses into Crushing — kindness path');
        addLog(`    (lilithMinAffection: ${Math.round(stage.lilithMinAffection)} — expect > -76 → kindness)`);

        await debugSet('Lilith', 99);

        await stage.beforePrompt({
            ...DEFAULT_MESSAGE, anonymizedId: '0',
            content: 'Lilith, thank you. I appreciate you being honest with me.',
            isBot: false,
        });
        await stage.afterResponse({
            ...DEFAULT_MESSAGE, anonymizedId: '1',
            content: 'Lilith looked at her for a long moment without the smile.',
            isBot: true,
        });

        addLog(`    Lilith affection after cross: ${Math.round(stage.affection['Lilith'])}`);
        assert('Lilith crossed into Crushing (≥ 101)',
            stage.affection['Lilith'] >= 101);
        assert('"Lilith:Crushing:kindness" key fired (not rivalry)',
            stage.firedMilestones.has('Lilith:Crushing:kindness'));
        assert('"Lilith:Crushing:rivalry" NOT fired',
            !stage.firedMilestones.has('Lilith:Crushing:rivalry'));
        assert('kindness prompt contains scene text ("third visit")',
            stage.pendingMilestonePrompt?.includes('third visit') ?? false);

        refresh();
        await delay(800);

        // ── M6: Lilith rivalry path ──────────────────────────────────────────
        addLog('');
        addLog('▶ M6 · Lilith rivalry path detection');
        addLog('    (set minAffection below -76 via debug, re-cross into Smitten)');

        // Simulate Lilith having gone deep negative by manually setting her historical min
        // We can't set this directly via debug command, so we push her deep negative first
        await debugSet('Lilith', -177);   // puts her in Rivalmance briefly
        // That debug set doesn't move lilithMinAffection — only actual afterResponse crossings do.
        // So instead: set to -177, then run a real exchange so afterResponse sees it.
        await stage.beforePrompt({
            ...DEFAULT_MESSAGE, anonymizedId: '0',
            content: 'Lilith, I hate you. Get away from me.',
            isBot: false,
        });
        await stage.afterResponse({
            ...DEFAULT_MESSAGE, anonymizedId: '1',
            content: 'Lilith smiled. "As you wish," she said, and did not move.',
            isBot: true,
        });
        addLog(`    lilithMinAffection after deep-negative exchange: ${Math.round(stage.lilithMinAffection)}`);
        assert('lilithMinAffection updated to reflect negative affection',
            stage.lilithMinAffection <= -76);

        // Now push her into Smitten (first time) — should fire rivalry path
        await debugSet('Lilith', 149);   // just below Smitten (151)
        await stage.beforePrompt({
            ...DEFAULT_MESSAGE, anonymizedId: '0',
            content: 'Lilith, I love you. I choose you.',
            isBot: false,
        });
        await stage.afterResponse({
            ...DEFAULT_MESSAGE, anonymizedId: '1',
            content: 'Lilith went very still.',
            isBot: true,
        });

        addLog(`    Lilith affection: ${Math.round(stage.affection['Lilith'])}`);
        assert('"Lilith:Smitten:rivalry" key fired',
            stage.firedMilestones.has('Lilith:Smitten:rivalry'));
        assert('"Lilith:Smitten:kindness" NOT fired',
            !stage.firedMilestones.has('Lilith:Smitten:kindness'));
        assert('rivalry prompt contains scene text ("political crisis")',
            stage.pendingMilestonePrompt?.includes('political crisis') ?? false);

        refresh();
        await delay(800);

        // ── Summary ──────────────────────────────────────────────────────────
        addLog('');
        addLog('━━ MILESTONE TEST COMPLETE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        addLog(`firedMilestones: ${[...stage.firedMilestones].join(' · ')}`);
        addLog('');
        addLog('NOTE: Milestone prompt text is sent to the LLM ONCE via stageDirections');
        addLog('and then discarded. Only the key is stored in firedMilestones.');
        addLog('If a permanent record of when/which scenes fired is needed,');
        addLog('add a milestoneLog array to MessageStateType and AnalysisHistoryEntry.');
    }

    async function runTests() {
        await delay(400); // brief pause before starting

        // Exchanges 1–7
        for (let i = 0; i < TEST_EXCHANGES.length - 1; i++) {
            const ex = TEST_EXCHANGES[i];
            await runExchange(ex.user, ex.bot, ex.label);
        }

        // Exchange 8: simulate a swipe by rolling back to the state before exchange 7.
        addLog('↩ Simulating swipe — rolling state back one exchange…');
        const snapshotBefore7 = {
            affection: { ...stage.affection },
            history:   [...stage.history],
        };
        await runExchange(
            TEST_EXCHANGES[6].user,
            TEST_EXCHANGES[6].bot,
            TEST_EXCHANGES[6].label + ' (about to swipe away)'
        );
        await stage.setState(snapshotBefore7 as any);
        addLog('  ✓ setState called — affection & history reverted to pre-exchange-7 state');
        refresh();
        await delay(800);

        addLog('✅ Standard exchanges complete.');

        // Run milestone smoke tests
        await runMilestoneTests();

        addLog('');
        addLog('✅ All tests complete.');
        setStatus('✅ Done — see DevTools console for full output.');
    }

    useEffect(() => {
        stage.load().then(res => {
            if (!res.success || res.error != null) {
                addLog(`❌ load() failed: ${res.error}`);
            } else {
                addLog('✓ Stage loaded. Running test exchanges…');
                runTests();
            }
        });
    }, []);

    return (
        <div style={{
            display:    'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width:      '100vw',
            height:     '100vh',
            background: '#050108',
            fontFamily: '"Courier New", monospace',
            fontSize:   '12px',
            color:      '#4a8a6a',
        }}>
            {status}
        </div>
    );
};
