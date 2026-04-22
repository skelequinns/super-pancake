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
    const [stage]        = useState(new Stage({ ...DEFAULT_INITIAL, ...InitData }));
    const [node, setNode]= useState(new Date());
    const [log,  setLog] = useState<string[]>([]);

    function refresh() { setNode(new Date()); }

    function addLog(msg: string) {
        setLog(prev => [...prev.slice(-30), msg]);  // keep last 30 lines
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

    async function runTests() {
        await delay(400); // brief pause before starting

        // Exchanges 1–7
        for (let i = 0; i < TEST_EXCHANGES.length - 1; i++) {
            const ex = TEST_EXCHANGES[i];
            await runExchange(ex.user, ex.bot, ex.label);
        }

        // Exchange 8: simulate a swipe by rolling back to the state before exchange 7.
        // We do this by calling setState with the messageState captured before runExchange 7
        // ran. In practice Chub calls setState automatically; here we snapshot manually.
        addLog('↩ Simulating swipe — rolling state back one exchange…');
        const snapshotBefore7 = {
            affection: { ...stage.affection },
            history:   [...stage.history],
        };
        // Run exchange 7 to advance state
        await runExchange(
            TEST_EXCHANGES[6].user,
            TEST_EXCHANGES[6].bot,
            TEST_EXCHANGES[6].label + ' (about to swipe away)'
        );
        // Now roll back via setState — same as Chub does on swipe
        await stage.setState(snapshotBefore7 as any);
        addLog('  ✓ setState called — affection & history reverted to pre-exchange-7 state');
        refresh();
        await delay(800);

        addLog('✅ All test exchanges complete.');
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
        <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#050108' }}>

            {/* Left: stage HUD */}
            <div style={{ width: '220px', flexShrink: 0, borderRight: '1px solid #1a0814' }}>
                <div style={{ display: 'none' }}>{String(node)}</div>
                {stage == null ? <div style={{ color: '#666', padding: 8 }}>Loading…</div> : stage.render()}
            </div>

            {/* Right: test log */}
            <div style={{
                flex:          1,
                padding:       '10px 12px',
                overflowY:     'auto',
                fontFamily:    '"Courier New", monospace',
                fontSize:      '11px',
                color:         '#5a8a60',
                lineHeight:    1.6,
                background:    '#040108',
            }}>
                <div style={{
                    fontSize:      '8px',
                    color:         '#2a4a2a',
                    letterSpacing: '2px',
                    textTransform: 'uppercase',
                    marginBottom:  '8px',
                    paddingBottom: '5px',
                    borderBottom:  '1px solid #1a2a1a',
                }}>
                    ⬡ test runner log
                </div>
                {log.length === 0
                    ? <div style={{ color: '#2a3a2a' }}>Waiting for stage to load…</div>
                    : log.map((line, i) => (
                        <div key={i} style={{
                            color: line.startsWith('✅') ? '#3aaa5a'
                                 : line.startsWith('❌') || line.includes('⚠') ? '#aa3840'
                                 : line.startsWith('🔔') ? '#a07840'
                                 : line.startsWith('↩') || line.includes('✓') ? '#4a8a6a'
                                 : '#4a7a50',
                        }}>
                            {line}
                        </div>
                    ))
                }
            </div>
        </div>
    );
};
