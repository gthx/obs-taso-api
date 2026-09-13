<script>
    /**
     * Shared lower-third base for the Inssi-Divari "planssit".
     *
     * Rebuilt from the shipped 1920x1080 assets rather than using them, because
     * every variant needs live text. `inssidivari_lopputulos_planssi.png`,
     * `inssidivari_kotijoukkuemaali_planssi.png` and
     * `inssidivari_vierasjoukkuemaali_planssi.png` are pixel-identical above
     * y=920 - same bar, same tab, same score box - so that part is this
     * component and the variants only supply:
     *
     *   - `tabText`  "LOPPUTULOS" on the result plansi, the goal time on a goal
     *                one, the period on an intermission
     *   - `strip`    what hangs under the bar: the half-width scorer/assist
     *                bar on a goal, or the full-width countdown bar on an
     *                intermission. Nothing on the result plansi.
     *
     * Measured off the assets at 1920x1080 (see the CSS for the conversions):
     *   bar        x 378..1542 (1165x76) at y 845, white, 8px radius
     *   tab        198x51 centred above the bar, #7e66bd, 8px top radius
     *   score box  198x76 centred in the bar, 5px #7e66bd border on #542c8c
     *   strip      582x64, 12px below the bar, #7e66bd, 8px bottom radius,
     *              bar-left edge to centre (home) or centre to bar-right (away)
     *
     * The type is TWO faces, read off the text layers in
     * `Broadcast -SalibandyTV - Inssi-Divari 2026-2027.psd` (the shipped PNGs
     * carry shapes only, and the `Havainnekuvat/` renders are set in a third
     * face, HeadingPro Bold, that the league did not ship - do not measure
     * type off those):
     *   team names  Nineties Headliner 33.33px
     *   score       Nineties Headliner 50px
     *   tab         Urbanist Bold 25px, 40/1000em tracking
     *   strip       Urbanist Bold 25px
     * Each one's computed ink width lands within a pixel or two of the
     * matching PSD layer's bounding box, so these are the real numbers.
     */

    import InssiDivariLogo from "./InssiDivariLogo.svelte";

    let {
        tabText = "",
        homeTeamName = "",
        awayTeamName = "",
        homeTeamLogo = "",
        awayTeamLogo = "",
        homeScore = 0,
        awayScore = 0,
        /**
         * What hangs under the bar, if anything. Two shapes so far:
         *   {kind:"goal",  side:"home"|"away", scorer, assist}
         *   {kind:"break", countdown, label}
         * @type {any}
         */
        strip = null,
        /**
         * The wordmark bar, moved above the score bar. Only the full-screen
         * planssit use it - a goal plansi is a lower third and has none.
         *   {countdown?, label}
         * @type {any}
         */
        header = null,
        /**
         * What fills the screen under the bar:
         *   {kind:"timeline", groups:[{period, goals:[...]}]}
         *   {kind:"stats", stats:[{label, home, away}], scorers:{home,away}}
         * @type {any}
         */
        body = null,
    } = $props();

    /* The full-screen planssit are a frame, not a stack: the score bar is
       pinned near the top of the picture and the wordmark bar sits back down at
       the bottom where it has always been, so the composition has a known top
       and bottom edge and the data lives between them.

       At 1920x1080 that is:

         60  tab top edge
         51  tab (sits on top of the bar)
         76  score bar
        ---
        187  content starts, hard against the bar
        921  content ends
         12  gap
        933  wordmark bar, its original y - 92 tall, bottom edge at 1025

       The 734 in between is the nominal budget, used only until the first
       measurement lands. What the rows are actually fitted to is the measured
       height of the content area, because it is pinned at both ends: that keeps
       the graphic correct in a browser window of any shape, not just in OBS's
       16:9 source. */
    const BODY_HEIGHT = 734;

    /* Measured in real pixels, both on the same element tree: the content area's
       height, and the width of the 1165-wide column it sits in. The ratio
       between them converts one into the other's units. */
    let bodyPx = $state(0);
    let plansiPx = $state(0);

    let bodyHeight = $derived(
        bodyPx && plansiPx ? (bodyPx * 1165) / plansiPx : BODY_HEIGHT,
    );

    /* Timeline row metrics. Deliberately tighter than
       `inssidivari_lineup_planssi.png`, whose row rhythm is airy enough that
       five goals would fill the screen - and with the rows collapsed into a
       table there is no per-row gap left to account for at all. */
    const GOAL_ROW = 40;
    const PERIOD_ROW = 24;

    /**
     * Goals come in as one flat list; the plansi groups them by period so each
     * stretch gets its own heading, the way the results service segments them.
     * @type {any}
     */
    let groups = $derived.by(() => {
        if (body?.kind !== "timeline") return [];

        const out = [];
        for (const goal of body.goals ?? []) {
            const last = out[out.length - 1];
            if (last && last.period === goal.period) last.goals.push(goal);
            else out.push({ period: goal.period, goals: [goal] });
        }
        return out;
    });

    /**
     * What the timeline is scaled by to use the height it has.
     *
     * Computed from the row counts rather than measured, so it is settled
     * It only ever shrinks. The row height is drawn for a single line of type
     * and stretching it just pads the row from the inside - the same vertical
     * looseness the table was meant to get rid of - so a short list stays at
     * its designed size and the room it does not need is left to the frame,
     * which has a bottom edge to hold it. A long one shrinks without a floor,
     * because shrinking beats clipping the last goals off the screen.
     *
     * The first pass uses the nominal budget, so a browser source is already
     * within a rounding error of right on the frame it goes live on; the
     * measurement then settles it exactly.
     */
    let timelineFit = $derived.by(() => {
        if (!groups.length) return 1;

        const needed = groups.reduce(
            (total, group) =>
                total + PERIOD_ROW + group.goals.length * GOAL_ROW,
            0,
        );

        return Math.min(1, bodyHeight / needed);
    });

    /* The two points tables are one table, so the lists are zipped: a row is
       whatever each side has in that position, and a side that has run out of
       scorers simply leaves its cells unpainted. */
    let scorerRows = $derived.by(() => {
        if (body?.kind !== "stats") return [];

        const home = body.scorers?.home ?? [];
        const away = body.scorers?.away ?? [];

        return Array.from(
            { length: Math.max(home.length, away.length) },
            (_, index) => ({
                home: home[index] ?? null,
                away: away[index] ?? null,
            }),
        );
    });

    function periodHeading(period) {
        if (period === 4) return "JATKOAIKA";
        if (period === 5) return "RANGAISTUSLAUKAUKSET";
        return `${period}. ERÄ`;
    }
</script>

<!--
  Nineties Headliner has proportional digits and no tnum feature, so anything
  that changes while on air has to be set on a fixed advance per glyph.
-->
{#snippet fixedDigits(value)}{#each String(value).split("") as ch}<span
            class="tick"
            class:colon={ch === ":"}>{ch}</span
        >{/each}{/snippet}

<!--
  One goal on the timeline. No crest: the side of the spine says which team it
  was, and both crests are already on the bar above - repeating them on every
  row spent 40px of width to say nothing new. That width is what lets the
  scorer and the assist share one line, which is what makes the row a single
  line tall.
-->
{#snippet goalCard(goal)}
    <span class="tl-card">
        <span class="tl-scorer">
            {goal.scorer}{#if goal.tag}<span class="tl-tag">{goal.tag}</span
                >{/if}
        </span>
        {#if goal.assist}
            <span class="tl-assist">({goal.assist})</span>
        {/if}
    </span>
{/snippet}

<!--
  One side of a points row. Shirt number to the outside, points to the inside,
  so the two teams' points columns meet in the middle and compare directly. A
  side with no player left renders its cells unpainted, the way the timeline
  leaves the flank of a goal the other team scored.
-->
{#snippet scorerCells(player, side)}
    {#if side === "home"}
        <td class="sc-num" class:filled={!!player}>
            {#if player}#{@render fixedDigits(player.number)}{/if}
        </td>
        <td class="sc-name" class:filled={!!player}>{player?.name ?? ""}</td>
    {/if}

    <td class="sc-pts {side}" class:filled={!!player}>
        {#if player}
            {@render fixedDigits(
                `${player.goals}+${player.assists}=${player.points}`,
            )}
        {/if}
    </td>

    {#if side === "away"}
        <td class="sc-name away" class:filled={!!player}>{player?.name ?? ""}</td>
        <td class="sc-num" class:filled={!!player}>
            {#if player}#{@render fixedDigits(player.number)}{/if}
        </td>
    {/if}
{/snippet}

<div
    class="plansi"
    class:full={!!header || !!body}
    bind:clientWidth={plansiPx}
>
    <div class="plansi-bar">
        <div class="plansi-tab">{tabText}</div>

        {#if homeTeamLogo}
            <img class="plansi-logo" src={homeTeamLogo} alt={homeTeamName} />
        {:else}
            <span class="plansi-logo-gap"></span>
        {/if}

        <span class="plansi-team home">{homeTeamName}</span>

        <div class="plansi-score">
            <span class="plansi-score-value"
                >{@render fixedDigits(homeScore)}</span
            >
            <span class="plansi-score-dash">-</span>
            <span class="plansi-score-value"
                >{@render fixedDigits(awayScore)}</span
            >
        </div>

        <span class="plansi-team away">{awayTeamName}</span>

        {#if awayTeamLogo}
            <img class="plansi-logo" src={awayTeamLogo} alt={awayTeamName} />
        {:else}
            <span class="plansi-logo-gap"></span>
        {/if}
    </div>

    <!--
      The content area is what is left between the two bars, measured rather
      than assumed: the composition is pinned top and bottom, so at any frame
      shape this is the real room the goals have. `plansiPx` converts it back
      into the 1165-wide design pixels the row metrics are written in.
    -->
    {#if body}
        <div class="plansi-body" bind:clientHeight={bodyPx}>
            {#if body.kind === "timeline"}
                <!--
                  A table, not a stack of floating rows. The goals butt straight
                  up against each other: the 6px that used to sit between them
                  was background showing through on every single row, and on a
                  long match that gap was the single biggest consumer of the
                  height. Now consecutive goals by the same team merge into one
                  white block and only a hairline separates them, which is also
                  how the results service reads.

                  The centre column is the score box's own 198 carried
                  downwards, so the spine is continuous by construction rather
                  than by a line drawn behind the rows.
                -->
                <table
                    class="timeline"
                    style="--fit: {timelineFit}"
                >
                    <colgroup>
                        <col />
                        <col class="tl-spine-col" />
                        <col />
                    </colgroup>
                    <tbody>
                        {#each groups as group (group.period)}
                            <tr class="tl-period">
                                <td colspan="3">{periodHeading(group.period)}</td
                                >
                            </tr>

                            {#each group.goals as goal (goal.time + goal.score)}
                                <tr class="tl-row">
                                    <td
                                        class="tl-side home"
                                        class:filled={goal.side === "home"}
                                    >
                                        {#if goal.side === "home"}
                                            {@render goalCard(goal)}
                                        {/if}
                                    </td>

                                    <td class="tl-node">
                                        <span class="tl-node-inner">
                                            <span class="tl-time"
                                                >{@render fixedDigits(
                                                    goal.time,
                                                )}</span
                                            >
                                            <span class="tl-score"
                                                >{@render fixedDigits(
                                                    goal.score,
                                                )}</span
                                            >
                                        </span>
                                    </td>

                                    <td
                                        class="tl-side away"
                                        class:filled={goal.side === "away"}
                                    >
                                        {#if goal.side === "away"}
                                            {@render goalCard(goal)}
                                        {/if}
                                    </td>
                                </tr>
                            {/each}
                        {/each}
                    </tbody>
                </table>
            {:else if body.kind === "stats"}
                <!--
                  The comparison, as tight as the timeline and built the same
                  way: contiguous rows, a hairline between them, and the two
                  value columns forming a continuous purple edge down each side
                  instead of five separate floating bars.
                -->
                <table class="stats">
                    <colgroup>
                        <col class="st-value-col" />
                        <col />
                        <col class="st-value-col" />
                    </colgroup>
                    <tbody>
                        {#each body.stats ?? [] as row (row.label)}
                            <tr class="st-row">
                                <td class="st-value"
                                    >{@render fixedDigits(row.home)}</td
                                >
                                <td class="st-label">{row.label}</td>
                                <td class="st-value"
                                    >{@render fixedDigits(row.away)}</td
                                >
                            </tr>
                        {/each}
                    </tbody>
                </table>

                <div class="stats-heading">
                    <span class="section-pill">MAALIT JA SYÖTÖT</span>
                </div>

                <!--
                  The two points columns sit side by side in the middle and add
                  up to the score box's 198, so this plansi has the same spine
                  running down it as the timeline does.
                -->
                <table class="scorers">
                    <colgroup>
                        <col class="sc-num-col" />
                        <col />
                        <col class="sc-pts-col" />
                        <col class="sc-pts-col" />
                        <col />
                        <col class="sc-num-col" />
                    </colgroup>
                    <tbody>
                        {#each scorerRows as row, index (index)}
                            <tr class="sc-row">
                                {@render scorerCells(row.home, "home")}
                                {@render scorerCells(row.away, "away")}
                            </tr>
                        {/each}
                    </tbody>
                </table>
            {/if}
        </div>
    {/if}

    {#if strip?.kind === "break"}
        <div class="plansi-break">
            <div class="plansi-break-brand">
                <InssiDivariLogo />
            </div>

            <div class="plansi-break-countdown">
                {@render fixedDigits(strip.countdown)}
            </div>

            <div class="plansi-break-label">{strip.label}</div>
        </div>
    {:else if strip?.kind === "goal"}
        <div class="plansi-strip" class:away={strip.side === "away"}>
            <span class="plansi-strip-inner">
                {#if strip.scorer}
                    <span class="plansi-scorer">{strip.scorer}</span>
                {/if}
                {#if strip.assist}
                    <span class="plansi-assist">{strip.assist}</span>
                {/if}
            </span>
        </div>
    {/if}

    {#if header}
        <div class="plansi-break plansi-header">
            <div class="plansi-break-brand">
                <InssiDivariLogo />
            </div>

            {#if header.countdown}
                <div class="plansi-break-countdown">
                    {@render fixedDigits(header.countdown)}
                </div>
            {/if}

            <div class="plansi-break-label">{header.label}</div>
        </div>
    {/if}
</div>

<style>
    /* Every length below is the measured 1920-wide pixel value divided by
       19.2, so the panel keeps the asset's proportions at any output size. */
    .plansi {
        position: fixed;
        left: 50%;
        /* The bar is the anchor, not the tab: the tab hangs off its top edge
           and the strip off its bottom, so result and goal planssit put the
           white bar in exactly the same place. 845/1080. */
        top: 78.2407%;
        transform: translateX(-50%);
        width: 60.677vw; /* 1165 */
        /* The bar's own type - names and score. The tab and the strip opt in
           to Urbanist below. */
        font-family: "Nineties Headliner", "Arial Black", Arial, sans-serif;
        user-select: none;
        cursor: none;
    }

    /* Full-screen variants. The column keeps its width and its centre line and
       gains a bottom edge: the score bar moves up to the top of the picture and
       the wordmark bar stays where every plansi has always put it, so the two
       bracket the data instead of stacking above it. y60 to y1025 of 1080. */
    .plansi.full {
        display: flex;
        flex-direction: column;
        top: 5.556%; /* 60 - the tab's top edge */
        bottom: 5.093%; /* 1025 */
    }

    /* Room for the tab, which hangs off the top of the bar here as on every
       other plansi and would otherwise overflow the frame. */
    .plansi.full .plansi-bar {
        flex-shrink: 0;
        margin-top: 2.656vw; /* 51 */
    }

    /* Pinned to the bottom edge whatever the content above it does. */
    .plansi.full .plansi-header {
        margin-top: 0.625vw; /* 12 */
        flex-shrink: 0;
    }

    /* Everything left between the two bars. `flex-basis: 0` with the overflow
       hidden is what makes the measurement safe: the area's height comes only
       from the frame, never from the rows inside it, so scaling the rows to the
       measured height cannot feed back into the measurement. */
    .plansi-body {
        flex: 1 1 0;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .plansi-bar {
        position: relative;
        display: flex;
        align-items: center;
        height: 3.958vw; /* 76 */
        padding: 0 0.625vw; /* 12 */
        box-sizing: border-box;
        background: #fff;
        border-radius: 0.417vw; /* 8 */
    }

    .plansi-tab {
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 10.313vw; /* 198 - the score box width */
        height: 2.656vw; /* 51 */
        box-sizing: border-box;
        background: #7e66bd;
        border-radius: 0.417vw 0.417vw 0 0;
        color: #fff;
        font-family: "Urbanist", Arial, sans-serif;
        font-weight: 700;
        font-size: 1.302vw; /* 25 */
        line-height: 1;
        letter-spacing: 0.04em; /* PSD tracking 40/1000em */
        white-space: nowrap;
    }

    /* The asset darkens the bottom 7px of the tab to ~82% - the score box
       casting a shadow up onto it. Without this the two purples read as one
       flat shape. */
    .plansi-tab::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 0.365vw; /* 7 */
        background: linear-gradient(
            to bottom,
            rgba(0, 0, 0, 0),
            rgba(0, 0, 0, 0.18)
        );
    }

    .plansi-logo,
    .plansi-logo-gap {
        width: 3.333vw; /* 64 */
        height: 3.333vw;
        flex-shrink: 0;
        object-fit: contain;
    }

    .plansi-team {
        flex: 1;
        min-width: 0;
        color: #0a0a0a;
        font-size: 1.736vw; /* 33.33 */
        line-height: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    /* Both names hug the score box rather than centring in their half -
       25px of air on either side of it in the PSD. */
    .plansi-team.home {
        text-align: right;
        padding-right: 1.302vw; /* 25 */
    }

    .plansi-team.away {
        text-align: left;
        padding-left: 1.302vw; /* 25 */
    }

    .plansi-score {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 10.313vw; /* 198 */
        /* Full bar height, square corners, sitting on top of the white bar -
           a 5px #7e66bd border on all four sides. */
        height: 100%;
        box-sizing: border-box;
        background: #542c8c;
        border: 0.26vw solid #7e66bd; /* 5 */
        color: #fff;
        font-size: 2.604vw; /* 50 */
        line-height: 1;
    }

    .plansi-score-value {
        display: inline-flex;
    }

    .plansi-score-dash {
        padding: 0 0.1vw;
    }

    .tick {
        display: inline-block;
        width: 0.56em;
        text-align: center;
    }

    .tick.colon {
        width: 0.26em;
    }

    /* Intermission: the old standalone break bar, re-cut to the plansi's width
       and hung off the bar instead of floating on its own. Its look is the
       user's, not the PSD's - the league's eratauko asset has no text layers -
       so the fill, the 5px border and the 10px radius are carried over as they
       were. Height is 92 rather than the asset's 107: the plansi bar above it
       is the fixed element at y845, so the strip is what has to give for the
       composition to end at y1025, just inside the 5% title-safe line. */
    .plansi-break {
        position: relative;
        display: flex;
        align-items: center;
        height: 4.8vw; /* 92 */
        margin-top: 0.625vw; /* 12 - same gap as the goal strip */
        padding: 0 2.4%;
        box-sizing: border-box;
        background: #542c8c;
        border: 0.26vw solid #7e66bd; /* 5 */
        border-radius: 0.52vw; /* 10 */
        color: #fff;
    }

    .plansi-break-brand {
        width: 22.9%;
        height: 70%;
        flex-shrink: 0;
    }

    /* Centred in the bar regardless of what flanks it */
    .plansi-break-countdown {
        position: absolute;
        left: 0;
        right: 0;
        text-align: center;
        font-size: 3.05vw;
        letter-spacing: 0.02em;
        pointer-events: none;
    }

    .plansi-break-label {
        flex-shrink: 0;
        margin-left: auto;
        font-size: 1.7vw;
        letter-spacing: 0.02em;
        white-space: nowrap;
    }

    /* Goal plansi only: half-width strip under the bar, on the scoring side */
    .plansi-strip {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 49.957%; /* 582/1165 */
        height: 3.333vw; /* 64 */
        margin-top: 0.625vw; /* 12 */
        background: #7e66bd;
        border-radius: 0 0 0.417vw 0.417vw;
        color: #fff;
    }

    .plansi-strip.away {
        margin-left: auto;
    }

    /* Scorer and assist centre as one group, not individually. The PSD has
       them as a single Urbanist Bold run at one size, separated by spaces -
       the Havainnekuva showing the assist smaller is that render's own idea. */
    .plansi-strip-inner {
        font-family: "Urbanist", Arial, sans-serif;
        font-weight: 700;
        font-size: 1.302vw; /* 25 */
        display: flex;
        align-items: baseline;
        gap: 1.25vw; /* 24 */
        white-space: nowrap;
    }

    .plansi-scorer,
    .plansi-assist {
        line-height: 1;
    }

    /* ---------------------------------------------------------------- *
     * Intermission timeline
     * ---------------------------------------------------------------- */

    /* `--fit` drives the vertical rhythm and the type, and touches neither
       column: the spine has to stay the score box's own 198 at
       every scale, and a long match then simply gains horizontal room for the
       names as it loses height. */
    .timeline {
        width: 100%;
        table-layout: fixed;
        /* Separated with zero spacing rather than collapsed. Every rule below
           is drawn with an inset shadow, which costs no layout at all, so the
           table's height is exactly the sum of its row heights and the fitting
           arithmetic stays exact. Collapsed borders add a fraction of a pixel
           per row, which over twenty rows is a clipped goal. */
        border-collapse: separate;
        border-spacing: 0;
    }

    /* The browser's own stylesheet gives every cell 1px of padding, and a
       cell's `height` is its content box - so without this every row came out
       two pixels taller than it was told to be, and twenty rows of that is a
       goal clipped off the bottom. */
    .timeline td {
        padding: 0;
    }

    .tl-spine-col {
        width: 10.313vw; /* 198 - the score box, carried down */
    }

    /* The period reads as a section rule across the whole table rather than a
       pill on the spine: with the rows butted together there is no gap left for
       a pill to float in, and a full-width band divides the match more clearly
       anyway. */
    .tl-period td {
        height: calc(var(--fit, 1) * 1.25vw); /* 24 */
        /* line-height, not height, is what a table cell honours exactly */
        line-height: calc(var(--fit, 1) * 1.25vw);
        background: #7e66bd;
        color: #fff;
        font-family: "Urbanist", Arial, sans-serif;
        font-weight: 700;
        font-size: calc(var(--fit, 1) * 0.781vw); /* 15 */
        letter-spacing: 0.08em;
        text-align: center;
        vertical-align: middle;
    }

    /* Every cell's content is a block-level flex box, so the cell generates no
       line box of its own. That matters: an inline child sits on a line box
       that can end up a pixel or two taller than the height asked for, and over
       twenty rows those pixels are a goal clipped off the bottom. With no line
       box the used height is exactly the height declared, and the fitting
       arithmetic is exact. */
    .tl-row td {
        height: calc(var(--fit, 1) * 2.083vw); /* 40 */
        line-height: 1;
        vertical-align: middle;
    }

    /* Only the side that scored is painted. Consecutive goals by one team then
       read as a single white block, which is the whole point of dropping the
       gaps. */
    .tl-side.filled {
        background: #fff;
        box-shadow: inset 0 -1px 0 rgba(84, 44, 140, 0.18);
    }

    .tl-row:last-child .tl-side.filled {
        box-shadow: none;
    }

    /* Time and score on one line. Stacked, they cost a two-line row height on
       every goal for the sake of two short numbers. */
    /* The spine's own edges are inset shadows too, so the centre column stays
       exactly the score box's 198 instead of 198 plus two borders. */
    .tl-node {
        background: #542c8c;
        box-shadow:
            inset 0.156vw 0 0 #7e66bd,
            inset -0.156vw 0 0 #7e66bd,
            inset 0 -1px 0 rgba(255, 255, 255, 0.16);
        color: #fff;
        text-align: center;
        white-space: nowrap;
    }

    .tl-row:last-child .tl-node {
        box-shadow:
            inset 0.156vw 0 0 #7e66bd,
            inset -0.156vw 0 0 #7e66bd;
    }

    .tl-node-inner {
        display: flex;
        align-items: baseline;
        justify-content: center;
    }

    .tl-time {
        display: inline-block;
        line-height: 1;
        margin-right: calc(var(--fit, 1) * 0.625vw); /* 12 */
        font-family: "Urbanist", Arial, sans-serif;
        font-weight: 700;
        font-size: calc(var(--fit, 1) * 0.885vw); /* 17 */
    }

    .tl-score {
        display: inline-block;
        line-height: 1;
        font-size: calc(var(--fit, 1) * 1.094vw); /* 21 */
    }

    .tl-side {
        padding: 0 calc(var(--fit, 1) * 0.729vw); /* 14 */
        overflow: hidden;
    }

    /* The names keep the same 25 off the spine that the bar's team names keep
       off the score box, so the two line up and neither crowds the middle. */
    .tl-side.home {
        padding-right: calc(var(--fit, 1) * 1.302vw); /* 25 */
    }

    .tl-side.away {
        padding-left: calc(var(--fit, 1) * 1.302vw); /* 25 */
    }



    /* Scorer and assist read inwards, ending against the spine, so a name sits
       beside the time and score it belongs to and lines up under the team name
       in the bar above. */
    .tl-card {
        display: flex;
        align-items: baseline;
        justify-content: flex-end;
        gap: calc(var(--fit, 1) * 0.417vw); /* 8 */
        min-width: 0;
        font-family: "Urbanist", Arial, sans-serif;
        line-height: 1;
        white-space: nowrap;
        overflow: hidden;
    }

    /* The away side reads from the spine outwards rather than mirroring the
       home one: mirroring would put the assist in front of the scorer, and the
       eye still reads left to right on both sides of the picture. So the home
       side's assist ends against the spine and the away side's scorer starts
       against it, and both rows read scorer-then-assist. */
    .tl-side.away .tl-card {
        justify-content: flex-start;
    }

    .tl-scorer {
        flex-shrink: 0;
        color: #0a0a0a;
        font-weight: 700;
        font-size: calc(var(--fit, 1) * 0.99vw); /* 19 */
        white-space: nowrap;
    }

    /* The assist is the brand purple rather than a grey: it reads as clearly
       subordinate to the near-black scorer while still belonging to the
       graphic, and holds far more contrast on white than #7e66bd would. It is
       also what gives way first when a row runs out of room. */
    .tl-assist {
        min-width: 0;
        color: #542c8c;
        font-weight: 700;
        font-size: calc(var(--fit, 1) * 0.833vw); /* 16 */
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    /* YV / AV / TM / RL / IM, as the match card tags the goal */
    .tl-tag {
        margin-left: 0.417vw; /* 8 */
        padding: 0.104vw 0.26vw;
        background: #542c8c;
        border-radius: 0.156vw;
        color: #fff;
        font-size: calc(var(--fit, 1) * 0.677vw);  /* 13 */
        letter-spacing: 0.04em;
        vertical-align: middle;
    }

    /* ---------------------------------------------------------------- *
     * Result statistics
     * ---------------------------------------------------------------- */



    /* Same construction as the timeline: one table, rows butted together,
       rules drawn with inset shadows so the row heights stay exact. */
    .stats,
    .scorers {
        width: 100%;
        table-layout: fixed;
        border-collapse: separate;
        border-spacing: 0;
    }

    .stats td,
    .scorers td {
        padding: 0;
        line-height: 1;
        vertical-align: middle;
    }

    .st-value-col {
        width: 5.521vw; /* 106 */
    }

    /* 60 rather than the 76-plus-a-gap these rows used to take. Five numbers
       do not need a third of the screen, and what they give up goes to the
       points table underneath. */
    .st-row td {
        height: 3.125vw; /* 60 */
    }

    .st-value {
        background: #542c8c;
        box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.16);
        color: #fff;
        font-size: 1.667vw; /* 32 */
        text-align: center;
    }

    .st-label {
        background: #fff;
        box-shadow: inset 0 -1px 0 rgba(84, 44, 140, 0.18);
        color: #0a0a0a;
        font-family: "Urbanist", Arial, sans-serif;
        font-weight: 700;
        font-size: 1.146vw; /* 22 */
        letter-spacing: 0.04em;
        text-align: center;
    }

    .st-row:last-child td {
        box-shadow: none;
    }

    .stats-heading {
        display: flex;
        justify-content: center;
        margin-top: 1.25vw; /* 24 */
        margin-bottom: 0.521vw; /* 10 */
    }

    .section-pill {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 10.313vw; /* 198 - the spine width */
        height: 1.458vw; /* 28 */
        padding: 0 0.833vw; /* 16 */
        box-sizing: border-box;
        background: #7e66bd;
        border-radius: 0.208vw; /* 4 */
        color: #fff;
        font-family: "Urbanist", Arial, sans-serif;
        font-weight: 700;
        font-size: 0.885vw; /* 17 */
        line-height: 1;
        letter-spacing: 0.04em;
        white-space: nowrap;
    }

    .sc-num-col {
        width: 4.167vw; /* 80 */
    }

    /* Two of these make the score box's 198, so the points meet on the same
       centre line the timeline's times run down. */
    .sc-pts-col {
        width: 5.156vw; /* 99 */
    }

    .sc-row td {
        height: 2.917vw; /* 56 */
    }

    .sc-num.filled,
    .sc-name.filled {
        background: #fff;
        box-shadow: inset 0 -1px 0 rgba(84, 44, 140, 0.18);
    }

    .sc-num {
        color: #542c8c;
        font-size: 1.146vw; /* 22 */
        text-align: center;
    }

    .sc-name {
        padding: 0 0.521vw; /* 10 */
        color: #0a0a0a;
        font-family: "Urbanist", Arial, sans-serif;
        font-weight: 700;
        font-size: 1.042vw; /* 20 */
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .sc-name.away {
        text-align: right;
    }

    .sc-pts.filled {
        background: #542c8c;
        color: #fff;
        font-size: 1.25vw; /* 24 */
        text-align: center;
    }

    /* The spine's outer edges, and a hairline down the middle of it so the two
       teams' points do not read as one number. */
    .sc-pts.home.filled {
        box-shadow:
            inset 0.156vw 0 0 #7e66bd,
            inset 0 -1px 0 rgba(255, 255, 255, 0.16);
    }

    .sc-pts.away.filled {
        box-shadow:
            inset -0.156vw 0 0 #7e66bd,
            inset 1px 0 0 rgba(255, 255, 255, 0.25),
            inset 0 -1px 0 rgba(255, 255, 255, 0.16);
    }

    .sc-row:last-child .sc-num.filled,
    .sc-row:last-child .sc-name.filled {
        box-shadow: none;
    }

    .sc-row:last-child .sc-pts.home.filled {
        box-shadow: inset 0.156vw 0 0 #7e66bd;
    }

    .sc-row:last-child .sc-pts.away.filled {
        box-shadow:
            inset -0.156vw 0 0 #7e66bd,
            inset 1px 0 0 rgba(255, 255, 255, 0.25);
    }
</style>
