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
     *   - `tabText`  "RESULT" on the result plansi, the goal time on a goal one
     *   - `strip`    the scorer/assist bar, goal plansi only, home or away side
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

    let {
        tabText = "",
        homeTeamName = "",
        awayTeamName = "",
        homeTeamLogo = "",
        awayTeamLogo = "",
        homeScore = 0,
        awayScore = 0,
        /** @type {{side: "home"|"away", scorer?: string, assist?: string}|null} */
        strip = null,
    } = $props();
</script>

<!--
  Nineties Headliner has proportional digits and no tnum feature, so anything
  that changes while on air has to be set on a fixed advance per glyph.
-->
{#snippet fixedDigits(value)}{#each String(value).split("") as ch}<span
            class="tick"
            class:colon={ch === ":"}>{ch}</span
        >{/each}{/snippet}

<div class="plansi">
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

    {#if strip}
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
</style>
