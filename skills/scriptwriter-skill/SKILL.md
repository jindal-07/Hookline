---
name: scriptwriter-skill
description: Use when creating episodic scripts, ensuring series continuity, adapting story concepts into visual narratives, or preparing scripts with sufficient beats for storyboarding
allowed-tools: Read, Write, Bash(ls:*)
user-invocable: true
version: 1.0.0
metadata:
  mcpmarket-version: 1.0.0
---
# Scriptwriter Skill

Gives the Scriptwriter the expertise to write high-quality, structured scripts, with support for series continuity and sequels that build on earlier episodes.

## Overview

This skill supports writing:

- **Structurally complete scripts** - three-act structure with 9+ key narrative moments
- **Continuous series episodes** - consistent characters, setting and style
- **Visual scenes** - detailed descriptions that convert easily into storyboards

## Core Principles

### 1. Visual First

The script must convert easily into storyboards. Avoid abstract psychological description; use concrete, visual description.

❌ **Abstract**: Emma feels confused and afraid.
✅ **Visual**: Emma's eyes go wide, her fingers trembling as she turns the pages. A bead of sweat slides down her forehead.

### 2. Character Consistency

- Establish a canonical appearance description (on first appearance)
- Keep key identifiers consistent in later episodes
- Develop personality gradually and believably

### 3. Clear Structure

**Three-act structure**:

- Act One (~25%): Setup - establish the world, inciting incident
- Act Two (~50%): Confrontation - rising action, midpoint twist, low point
- Act Three (~25%): Resolution - climax, resolution, new equilibrium

### 4. Enough Beats

Make sure the script contains **at least 9** clear, visual turning points, spread across the three acts.

## Quick Start

### Workflow for a new episode

**Step 1: Review the series history**

```bash
# See existing episodes
ls script/

# Read earlier episodes to understand character and plot development
```

**Step 2: Develop the story from the user's input**

The user may provide:

- Theme keywords (e.g. "betrayal", "discovering the truth")
- Plot direction (e.g. "Character A discovers a secret")
- Emotional tone (e.g. "suspense", "heartwarming")

**Step 3: Plan the structure**

- Carry over the world and character states from earlier episodes
- Design 9+ key narrative moments
- Lay out the three-act structure

**Step 4: Write the script**

Use the standard scene format, making sure that:

- Scene heading: `## Scene {X} - {INT./EXT.} {Location} - {Time}`
- Characters appearing for the first time get a full appearance description
- Action is written in present tense and is visual
- There are enough beat candidates (≥9)

**Step 5: Output**

```
File naming: script/ep{XX}-{title}.md
Example: script/ep03-betrayal.md
```

## Series Continuity Checklist

Before writing a new episode:

- [ ] Read all previous episodes
- [ ] Character appearance descriptions match earlier episodes
- [ ] Character relationships match where the previous episode ended
- [ ] Unresolved plot threads are considered or advanced
- [ ] No contradictions in world-building
- [ ] Visual style and atmosphere stay consistent

## Output Constraints

**Strictly forbidden**:

- ❌ Frontmatter metadata
- ❌ Template instructions
- ❌ Overly abstract psychological description
- ❌ Scenes lacking visual detail

**Must include**:

- ✅ Scene number, location and time
- ✅ Appearance descriptions for characters on first appearance
- ✅ Visual scenes and action
- ✅ Enough key moments (≥9 beat candidates)
- ✅ A complete three-act structure

## Detailed Resources

### Methodology Guide 📖

- [screenplay-methodology.md](screenplay-methodology.md) - Screenwriting methodology
  - Three-act structure and story arcs
  - Character development principles
  - Scene construction techniques
  - Visual description methods
  - Series continuity management

### Writing Guidance 📖

- [GUIDELINES.md](GUIDELINES.md) - Detailed writing standards
  - Scene format standards (scene headings, time markers)
  - Character first-appearance rules
  - Action description best practices
  - Beat distribution guidance (allocating 9 beats across three acts)
  - Dialogue writing techniques
  - Output checklist

### Templates

- [templates/episode-template.md](templates/episode-template.md) - Standard episode script format
- [templates/series-continuity-guide.md](templates/series-continuity-guide.md) - Series continuity checklist

## When to Use

**Automatic triggers**:

- The user asks to "write a new episode"
- The user provides a story concept to turn into a script
- Material needs to be prepared for the Storyboard Artist

**Manual reference**:

- Unsure about scene format
- Handling series continuity issues
- Planning beat distribution
- Resolving character consistency issues

## Example Scene Format

```markdown
## Scene 5 - INT. Subway Car - Night

The car is dim, its white fluorescent lights flickering. A few discarded newspapers are scattered across the empty seats.

EMMA (25, long silver hair, deep red coat) sits by the window and opens an old leather notebook.
Dense handwritten symbols and a glowing hexagram pattern light up her face.

Suddenly, every light goes out.
```

---

**Usage**: The Scriptwriter agent references this skill automatically. The methodology and guidelines (marked 📖) use progressive disclosure and are consulted only when needed.
