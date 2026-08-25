/**
 * ============================================================
 *  STAFFBOT CONFIG — Tempest SMP
 * ============================================================
 *
 *  Already filled in with your role and channel IDs.
 *  Run check.bat any time to re-validate it.
 *
 *  Tuned for a server under ~1,000 members. See "SCORING" for why the
 *  targets are as low as they are.
 */

module.exports = {
  // ----------------------------------------------------------
  // 1. THE RANK LADDER
  // ----------------------------------------------------------
  // Order matters: index 0 is the LOWEST rank, last is the HIGHEST.
  // /promote moves a person one step up this list, /demote one step down.
  ranks: [
    { key: 'trial',     name: 'Trial Staff', roleId: '1522662146704539668' },
    { key: 'staff',     name: 'Staff',       roleId: '1510615626920493147' },
    { key: 'headstaff', name: 'Head Staff',  roleId: '1503657248793034893' },
    { key: 'mod',       name: 'Mod',         roleId: '1513855672763023410' },
    { key: 'headmod',   name: 'Head Mod',    roleId: '1513855451555696740' },
  ],

  // Your "Staff Team" ping role. Added on hire, removed on full removal.
  staffTeamRoleId: '1531486709873639454',

  // ----------------------------------------------------------
  // 2. WHO CAN USE WHAT
  // ----------------------------------------------------------
  // Remember the hard rule that applies on top of all of these:
  // you can never act on someone at or above your own rank, and you can
  // never place someone AT your own rank. So a Mod can promote people up
  // to Head Staff; only a Head Mod can make someone a Mod.
  // EVERY command is Head Mod and above. Ranks below Head Mod hold their
  // roles and are measured by the bot, but cannot run anything.
  //
  // Watch the vouch count: /vouch needs `scoring.vouches.minimum` (2) distinct
  // people, and the only people who can now cast one are Head Mods plus the
  // three override roles below. Staffbot counts them on startup and warns if
  // there are too few, because a trial that can never reach 2 vouches can
  // never be flagged READY.
  permissions: {
    manageStaff: 'headmod',    // /promote, /demote, /trial
    vouch: 'headmod',          // who gets a vote on trial members
    review: 'headmod',         // /review, /note, /staffstats, /trial list, /link

    // These bypass every rank check.
    //
    // They do NOT bypass each other: an Owner cannot demote the Founder, and
    // vice versa. Everyone holding one of these sits at the same ceiling, and
    // the "never act on someone at or above your own rank" rule still applies
    // between them. Only the Discord server owner is above all of it.
    overrideRoleIds: [
      '1503657119843614720',   // Founder
      '1514544622423113809',   // Owner
      '1518522106739032156',   // Co-Owner
    ],

    // Should people holding an override role be TRACKED as staff — measured,
    // scored, expected to have a Minecraft name linked?
    //
    // Almost always no. Owners hold a rank role for the colour and the
    // permissions, not because they are on a performance ladder. Left true,
    // they clutter /link list, drag the staffing counts around and get
    // scorecards nobody asked for.
    trackOverrides: false,
  },

  // ----------------------------------------------------------
  // 3. CHANNELS
  // ----------------------------------------------------------
  channels: {
    // The separate private staff-log channel is switched OFF. Every rank
    // change now goes to ONE place publicly (see 3b), plus a DM to the person.
    //
    // The private `reason:` is still recorded — it just lives in the database
    // and their DM instead of a channel. Run /staffstats on anyone to read
    // their full rank history with reasons. Put a channel ID back here if you
    // ever want the in-channel audit trail again.
    staffLog: null,

    reviews: '1525828018528981044',     // trial review cards land here
    staffChannels: ['1525819782643978371'],
    // TODO: channel IDs from the server you were testing in. Add the real
    // ones from Tempest SMP, or leave empty — nothing breaks either way.
    ignored: [],
  },

  // ----------------------------------------------------------
  // 3c. IN-GAME CHAT BRIDGE
  // ----------------------------------------------------------
  // Your Discord channel that mirrors Minecraft chat. Staff who are actually
  // in-game show up here, so it is the best available read on whether a trial
  // is present on the server and how they talk to players.
  //
  // The catch: those messages are posted by the bridge, not by the staff
  // member's Discord account. Staffbot works out who is who from the
  // Minecraft username, which you map with /link.
  gameChat: {
    enabled: true,

    // Your DiscordSRV chat channel.
    channelId: '1525821924146679929',

    // Tuned for DiscordSRV's stock formats:
    //   with a rank:  **Owner** Jamie_MC » hello
    //   without one:  Jamie_MC » hello
    // The (?:\*\*...\*\*)? part skips the bolded rank prefix so the capture
    // lands on the PLAYER, not the group name.
    //
    // If you turned on Experiment_WebhookChatMessageDelivery, DiscordSRV posts
    // through a webhook named after the player instead — Staffbot detects that
    // automatically and this pattern is never used.
    namePattern: '^(?:\\*\\*[^*]{0,32}\\*\\*\\s*)?([A-Za-z0-9_]{3,16})\\s*»\\s*',

    // DiscordSRV sends joins, leaves, deaths and advancements as EMBEDS with
    // no message content, so they never reach the name parser in the first
    // place. This is just a belt-and-braces filter for the plain-text ones.
    ignorePattern: '^:\\w+:\\s|\\*\\*Server has (started|stopped)\\*\\*|joined the server|left the server|has made the advancement',

    // Nicknames: the pattern above expects a normal Minecraft username. If your
    // server uses nicknames with spaces or symbols, Staffbot falls back to
    // "whatever sits just before the »" — safe, because a name only ever counts
    // if it has been linked with /link.
    looseFallback: true,
  },

  // ----------------------------------------------------------
  // 3d. CONDUCT SAMPLE — reading how they actually talk
  // ----------------------------------------------------------
  // Numbers tell you whether someone showed up. They tell you nothing about
  // tone. This keeps a small rolling sample of a trial member's messages so a
  // human can read a few real lines before deciding.
  //
  // BE STRAIGHT WITH YOUR STAFF ABOUT THIS. It stores message content in the
  // bot's database. It is limited on purpose — trials only, a few dozen lines,
  // auto-purged — but "the bot keeps some of what you say" is something a
  // person should hear from you, not discover.
  conduct: {
    enabled: true,

    // Only sample people currently on a trial. Turning this off would collect
    // from every staff member permanently, which is a much bigger promise to
    // make to your team. Strongly recommended to leave true.
    onlyDuringTrial: true,

    // How many recent lines to keep per person. Older ones are dropped.
    sampleSize: 30,

    // Truncate each stored line to this many characters.
    maxLength: 220,

    // Never sample from these channels, whatever else is going on.
    excludeChannelIds: [],

    // Delete anything older than this regardless of sample size.
    retentionDays: 45,

    // Include Minecraft chat. This is often where tone with players shows
    // most clearly, so it is on by default.
    includeGameChat: true,
  },

  // ----------------------------------------------------------
  // 3b. STAFF MOVEMENTS — the PUBLIC announcement channel
  // ----------------------------------------------------------
  // This is now the ONLY channel Staffbot posts rank changes to. Members see
  // the movement and nothing else — never a reason, never who did it.
  announcements: {
    // TODO: this was the movements channel in the OTHER server and does not
    // exist here. Rank changes will post nowhere until you set the real one.
    channelId: null,

    // 'line'  — matches a hand-typed movements post:
    //             @Zac  Member  >  Trial Staff
    //             Reinstated
    // 'embed' — a card with a title and timestamp.
    style: 'line',

    // Render the ranks as @role pills instead of plain bold names?
    // Either way NOBODY in those roles is ever pinged — with pills on, the
    // mention renders but notifications are suppressed.
    mentionRoles: false,

    // Left of the arrow when someone has no rank yet (a new hire),
    // and right of it when someone is removed from the team.
    memberLabel: 'Member',
    removedLabel: 'Removed',

    // The small grey subtext line under the movement (Discord's "-# ").
    // Used when nobody typed a `note:` on the command. Set any to null or ''
    // to leave that kind of movement with no subtext at all.
    defaultNotes: {
      hire: 'Trial Started.',
      promote: 'Promoted.',
      demote: 'Demoted.',
      remove: 'Removed from the staff team.',
    },

    onHire: true,      // @Zac  Member  >  Trial Staff
    onPromote: true,   // @Zac  Staff   >  Head Staff
    onDemote: true,    // @Zac  Mod     >  Head Staff   (no reason attached)
    onRemove: false,   // leaving the team entirely stays private

    // Ping the person so they get a notification on their own movement.
    mentionMember: true,

    // The private `reason:` on /promote and /demote NEVER appears here. It
    // goes to the person's DM and the database, readable any time with
    // /staffstats. For a short public line under the movement
    // ("Reinstated", "Stepping back for exams"), use the separate optional
    // `note:` option on the command. Two fields on purpose: one is the honest
    // internal record, the other is what the server gets told.
  },

  // ----------------------------------------------------------
  // 4. TICKET KING INTEGRATION
  // ----------------------------------------------------------
  // Staffbot does NOT run tickets — Ticket King does. This section just
  // teaches Staffbot to watch Ticket King's channels so ticket work still
  // counts toward a trial's score.
  //
  // It works by watching the ticket CATEGORY, not by parsing Ticket King's
  // messages, so it keeps working if they change their embed wording.
  ticketKing: {
    enabled: true,

    // The category (or categories) Ticket King creates ticket channels in.
    // Find these in your Ticket King dashboard under each panel's settings,
    // then right-click the category in Discord > Copy ID.
    categoryIds: [
      '1510607597030609047',
    ],

    // Ticket King's bot user ID. Used to recognise its claim messages and to
    // ignore its own chatter when counting staff replies.
    botUserId: '710034409214181396',

    // OPTIONAL. If you use Ticket King's /claim, this regex is matched
    // against its messages in a ticket channel to work out who claimed it.
    // The first capture group that matches must be the claimer's user ID.
    // Leave it as-is and check the staff log — Staffbot reports whether it
    // ever detected a claim, so you will know within a day if it needs tuning.
    claimPattern: '<@!?(\\d+)>\\s*(?:has\\s+)?claimed|claimed\\s+by[^<]{0,20}<@!?(\\d+)>',

    // If nobody claims a ticket, credit whichever staff member sent the most
    // messages in it — provided they sent at least this many. Stops someone
    // getting credit for popping in to say "np" once.
    minMessagesToCredit: 3,

    // Count a ticket as handled by more than one person? When false, only the
    // top contributor is credited. When true, everyone over the threshold is.
    creditEveryone: false,
  },

  // ----------------------------------------------------------
  // 5. TRIAL SETTINGS
  // ----------------------------------------------------------
  trial: {
    defaultDays: 14,
    checkIntervalMinutes: 15,
    // Post a progress card at this fraction of the trial. null to disable.
    midpointCheckAt: 0.5,
  },

  // ----------------------------------------------------------
  // 6. SCORING — what "worthy" means, in numbers
  // ----------------------------------------------------------
  //
  //  >>> TUNED FOR A SERVER UNDER 1,000 MEMBERS. <<<
  //
  // In a quiet server there isn't enough trouble to generate a big mod-action
  // count, so mod actions are weighted LOW and ticket work is weighted HIGH —
  // tickets are what your staff actually do all day, and unlike message counts
  // they can't be faked.
  //
  // CALIBRATE THESE. Run /staffstats on a staff member you already trust and
  // set the targets slightly below what they actually do. The numbers below
  // are an educated guess, not a measurement.
  //
  // Targets are for the WHOLE trial period, not per day.
  scoring: {
    metrics: {
      ticketsHandled: {
        enabled: true,
        weight: 25,
        target: 8,
        label: 'Tickets handled',
        help: 'Tickets they claimed and saw through to a close',
      },
      activeDays: {
        enabled: true,
        weight: 20,
        target: 9,
        label: 'Active days',
        help: 'Distinct days they showed up at all. Catches the binge-then-vanish pattern.',
      },
      inGameActivity: {
        enabled: true,
        weight: 18,
        target: 80,
        requires: 'gameChat.channelId',   // skipped entirely if the bridge is not set up
        label: 'In-game presence',
        help: 'Messages they sent in Minecraft chat. The only metric that proves they actually play.',
      },
      channelBreadth: {
        enabled: true,
        weight: 6,
        target: 6,
        label: 'Channel spread',
        help: 'How many different channels they are actually present in. Catches someone who only ever lurks in one corner of the server.',
      },
      modActions: {
        enabled: true,
        weight: 12,
        target: 5,
        label: 'Mod actions',
        help: 'Bans, kicks, timeouts and deletes. Low target on purpose — a quiet server is a good thing.',
      },
      responseSpeed: {
        enabled: true,
        weight: 12,
        target: 20,
        direction: 'lower',       // fewer minutes = better
        unit: 'min',
        dataKey: 'responseCount', // skip this metric entirely if they handled no tickets
        label: 'Avg first response',
        help: 'How long a member waits after opening a ticket before this person replies',
      },
      staffPresence: {
        enabled: true,
        weight: 4,
        target: 30,
        label: 'Staff channel activity',
        help: 'Are they actually around and talking to the team',
      },
      publicActivity: {
        enabled: true,
        weight: 3,
        target: 100,
        label: 'Public activity',
        help: 'Visible in normal channels. Weighted low because it is the easiest thing to fake.',
      },
    },

    // Weights normalise automatically — disabling a metric doesn't break the
    // maths, the rest just scale up to fill 100%.

    autoFlag: {
      promote: 75,   // at or above this = READY (if vouches also pass)
      belowBar: 50,  // below this = BELOW BAR regardless of vouches
    },

    vouches: {
      minimum: 2,      // vouches needed before the vote counts at all
      passRatio: 0.66, // fraction of yes/no votes that must be yes
    },
  },

  // ----------------------------------------------------------
  // 7. ANTI-FARMING (leave alone unless you have a reason)
  // ----------------------------------------------------------
  tracking: {
    minMessageLength: 5,          // "k", "lol", "." don't count
    messageCooldownSeconds: 45,   // one counted message per channel per window
    countMessageDeletes: true,    // turn off if automod deletes under a staff name
  },

  // ----------------------------------------------------------
  // 8. COSMETIC
  // ----------------------------------------------------------
  colors: {
    promote: 0x4ade80,
    demote: 0xf87171,
    neutral: 0x60a5fa,
    ready: 0x22c55e,
    borderline: 0xfbbf24,
    belowBar: 0xef4444,
    ticket: 0x818cf8,
  },
};
