# Infernal Otome Engine
I really wanted an Otome game based in hell without all the Christian stuff. So I abstracted the bs ('God', 'Heaven', 'hell,' 'angels' etc. - now uses agnostic language though some of the names overlap) 

Designed to work with a specific bot, so don't @ me if it doesn't work with other bots. <3
[The Below - Infernal Otome](https://chub.ai/characters/skelequinn/the-below-infernal-otome-8b11e7823898)

## Core Features
The tracker manages affection scores for five love interests (Malivorn, Asmodeus, Lilith, Beelzebub, Mammon) across nine relationship tiers from Rivalmance to Devoted. Each character starts at a different affection value to reflect their personalities.
Every user message is analyzed for keyword categories — romantic, compliment, friendly, vulnerable, playful, apologetic, rude, and dismissive — and affection shifts accordingly. Named characters get a context-windowed analysis (sentiment near their name), while characters already established in the active scene get the global message delta applied automatically. Brand-new characters appearing in a bot response receive a small base delta. A hard cap of ±2 per character per message prevents runaway scoring.
The stage also tracks scene continuity — it detects when characters enter or leave a scene, handles scene transitions (e.g. moving rooms), and prunes characters from the active scene after 2 consecutive absent bot responses. Tier changes generate a system message to the LLM noting the relationship shift, and character behavior descriptions are injected into stage directions each turn to guide the LLM's portrayal.
The HUD displays each character's name, tier, affection value, and relationship symbols.

## Debug Features
* A debug panel beneath the HUD shows the last (or current pending) exchange: message excerpt, which keyword categories fired, active scene characters, detected scene characters, and applied deltas
* Tier change transitions are logged in the debug panel
* Three slash commands are available in chat: /set [Name|all] <value>, /add [Name|all] <value>, and /reset — these bypass LLM analysis entirely and inject a neutral narrator placeholder message instead

Author's note: Debug Features are temporary while testing (22/4/2026)
I am yamdancer on discord if you have any feedback or run into issues!
