/**
 * What the intermission and result planssit show, distilled from a getMatch
 * response.
 *
 * getScore - the endpoint that is actually polled during a match - carries the
 * clock and the score and nothing else, so everything here comes from getMatch,
 * which is fetched on demand when one of these planssit is about to go up.
 *
 * Two things about the source data drive the shape of this file:
 *
 *  - A goal and its assist are two separate rows in `events` ("maali" and
 *    "syotto"), tied together by the assist's `connected_event_id` pointing at
 *    the goal's `event_id`. The `goals` array on the match has no assist in it
 *    at all, so it is not used.
 *  - The running score is only reliably in the goal's `description`
 *    ("3-1", or "YV  3-0" when it was scored on the power play). `s_A`/`s_B`
 *    come back as "" rather than 0 for a side that has not scored yet, so the
 *    description is parsed instead.
 */

/** Goal-description prefixes. The rest of the description is the score. */
const POWER_PLAY = "YV"; // ylivoima
const SHORT_HANDED = "AV"; // alivoima

/** Anything that puts a player in the box, as the event code spells it. */
const PENALTY_CODE = /^(\d+min|MR|PR|OR)$/i;

/**
 * "1:42" -> "01:42". Torneopal drops the leading zero on the minutes and the
 * digits are set on a fixed advance on air, so an unpadded time would sit
 * off-centre in its box.
 */
function padTime(value) {
    const text = String(value ?? "").trim();
    const match = text.match(/^(\d+):(\d{2})$/);
    return match ? `${match[1].padStart(2, "0")}:${match[2]}` : text;
}

/** "#77 Sillanpää Miko", or just the name when the number is missing. */
function withNumber(number, name) {
    const player = String(name ?? "").trim();
    if (!player) return "";
    const shirt = String(number ?? "").trim();
    return shirt ? `#${shirt} ${player}` : player;
}

/**
 * The score after this goal. "YV  3-0" and "3-1" both yield "3-1"-shaped
 * output; a description we cannot read falls back to the s_A/s_B pair.
 */
function readScore(event) {
    const match = String(event.description ?? "").match(/(\d+)\s*-\s*(\d+)/);
    if (match) return `${match[1]}-${match[2]}`;

    const home = Number(event.s_A) || 0;
    const away = Number(event.s_B) || 0;
    return `${home}-${away}`;
}

/** The YV/AV/TM/RL/IM tag in front of the score, if there is one. */
function readTag(event) {
    const description = String(event.description ?? "").trim();
    const match = description.match(/^([A-ZÄÖ]{2})\s/);
    return match ? match[1] : "";
}

/**
 * Goals in the order they were scored, each already carrying its assist and
 * the side that scored it.
 *
 * @returns {Array<{side: "home"|"away", period: number, time: string,
 *                  score: string, tag: string, scorer: string, assist: string}>}
 */
export function buildTimeline(match) {
    const events = Array.isArray(match?.events) ? match.events : [];

    // Assists first: they are looked up by the goal they belong to, and an
    // assist row with no player on it (it happens) is no assist at all.
    const assists = new Map();
    for (const event of events) {
        if (event.code !== "syotto") continue;
        const goalId = String(event.connected_event_id ?? "");
        if (!goalId || goalId === "0") continue;
        const name = withNumber(event.shirt_number, event.player_name);
        if (name) assists.set(goalId, name);
    }

    return events
        .filter((event) => event.code === "maali")
        .map((event) => ({
            side: event.team === "B" ? "away" : "home",
            period: Number(event.period) || 1,
            time: padTime(event.time),
            score: readScore(event),
            tag: readTag(event),
            scorer: withNumber(event.shirt_number, event.player_name),
            assist: assists.get(String(event.event_id)) ?? "",
        }));
}

/** Sums a lineup field over one team. */
function lineupTotal(match, teamId, field) {
    const lineups = Array.isArray(match?.lineups) ? match.lineups : [];
    return lineups
        .filter((entry) => String(entry.team_id) === String(teamId))
        .reduce((total, entry) => total + (Number(entry[field]) || 0), 0);
}

/** How many times this side was sent off. */
function penaltyCount(match, side) {
    const events = Array.isArray(match?.events) ? match.events : [];
    return events.filter(
        (event) => PENALTY_CODE.test(event.code ?? "") && event.team === side,
    ).length;
}

/** Goals carrying a given tag, per side. */
function taggedGoals(timeline, tag) {
    return {
        home: timeline.filter((g) => g.side === "home" && g.tag === tag).length,
        away: timeline.filter((g) => g.side === "away" && g.tag === tag).length,
    };
}

/**
 * The five comparison rows of the result plansi. Shots are deliberately absent:
 * `lineups[].shots` comes back as 0 across the board at this level, so a shot
 * row would read as 0-0 on every match.
 *
 * @returns {Array<{label: string, home: number, away: number}>}
 */
export function buildStats(match, timeline) {
    const homeId = match?.team_A_id;
    const awayId = match?.team_B_id;
    const powerPlay = taggedGoals(timeline, POWER_PLAY);
    const shortHanded = taggedGoals(timeline, SHORT_HANDED);

    return [
        {
            label: "MAALIT",
            home: Number(match?.fs_A) || timeline.filter((g) => g.side === "home").length,
            away: Number(match?.fs_B) || timeline.filter((g) => g.side === "away").length,
        },
        { label: "YLIVOIMAMAALIT", home: powerPlay.home, away: powerPlay.away },
        {
            label: "ALIVOIMAMAALIT",
            home: shortHanded.home,
            away: shortHanded.away,
        },
        {
            label: "TORJUNNAT",
            home: lineupTotal(match, homeId, "saves"),
            away: lineupTotal(match, awayId, "saves"),
        },
        {
            label: "RANGAISTUKSET",
            home: penaltyCount(match, "A"),
            away: penaltyCount(match, "B"),
        },
    ];
}

/**
 * The top scorers of one team, most points first. Goals break a tie on points,
 * the way every points table does it.
 *
 * @returns {Array<{number: string, name: string, goals: number,
 *                  assists: number, points: number}>}
 */
function topScorers(match, teamId, limit) {
    const lineups = Array.isArray(match?.lineups) ? match.lineups : [];

    return lineups
        .filter((entry) => String(entry.team_id) === String(teamId))
        .map((entry) => ({
            number: String(entry.shirt_number ?? ""),
            name: String(entry.player_name ?? ""),
            goals: Number(entry.goals) || 0,
            assists: Number(entry.assists) || 0,
            points: (Number(entry.goals) || 0) + (Number(entry.assists) || 0),
        }))
        .filter((player) => player.points > 0 && player.name)
        .sort((a, b) => b.points - a.points || b.goals - a.goals)
        .slice(0, limit);
}

/** How many players each side of the result plansi has room for. */
const SCORER_ROWS = 3;

/**
 * Everything the two full-screen planssit need, in one payload small enough to
 * repeat on every resync.
 */
export function buildMatchDetail(match) {
    const timeline = buildTimeline(match);

    return {
        timeline,
        stats: buildStats(match, timeline),
        scorers: {
            home: topScorers(match, match?.team_A_id, SCORER_ROWS),
            away: topScorers(match, match?.team_B_id, SCORER_ROWS),
        },
    };
}
