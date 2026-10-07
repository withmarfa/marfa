# Occurrences and recurring events

An occurrence is one time an event happens. A recurring event is one `core.event` item, a series, that carries RFC 5545 rule lines in `recurrence`. The server computes its occurrences when a window is read. `GET /occurrences` answers them, and this chapter states how a series unfolds, what a window includes and what a write may store.

## The calendar operation

`GET /occurrences?from&to` reads the `core.event` items the credential may read, narrowed by `type` as `search-and-filters/type-wildcard` and the rules after it say.

### `occurrences/window-expands`

When `GET /occurrences` names a window, the server MUST answer the occurrences of the events that overlap it and no occurrence of an event that does not.

**Tests:** `compliance/occurrences.test.ts › expands events inside the window and excludes those outside it`.

### `occurrences/order`

The server MUST order the occurrences of `GET /occurrences` by `starts_at`, ascending, whatever order the events were written in.

**Tests:** `compliance/occurrences.test.ts › orders the window by starts_at ascending, not by write order`.

### `occurrences/answer-keys`

When `GET /occurrences` answers, the server MUST carry `data`, a `next_cursor` of `null`, the `window` it read in UTC, and a `scan` holding `events_read`, `occurrences`, `max_occurrences`, `series_errors`, `max_series_errors`, `unproductive_iterations`, `max_unproductive_iterations` and `series_unexpanded`, and beside them `series_errors`, `series_errors_truncated` and `expansion_incomplete` only where they apply.

**Reason:** the operation answers every occurrence of the window in one page, so there is no cursor to follow.

**Tests:** `compliance/occurrences.test.ts › expands events inside the window and excludes those outside it`, `compliance/envelope.test.ts › one envelope for every list and search`, `› answers a null cursor from every door that takes none`.

### `occurrences/window-required`

If `GET /occurrences` carries no `from` or no `to`, then the server MUST answer `400 missing_required_field`.

**Tests:** `compliance/occurrences.test.ts › refuses a missing or inverted window`.

### `occurrences/window-ordered`

If the `to` of `GET /occurrences` is not after its `from`, then the server MUST answer `400 validation_error`.

**Tests:** `compliance/occurrences.test.ts › refuses a missing or inverted window`, `› refuses a window whose end is its start`.

### `occurrences/window-instants`

The server MUST read each bound of a window as the instant it names, spelled in UTC, with an offset or as a date with no time, which is its midnight in UTC, and answer the window in UTC.

**Tests:** `compliance/occurrences.test.ts › reads each bound of the window in any ISO 8601 spelling and answers the window in UTC`.

### `occurrences/window-unreadable`

If a bound of the window is not a timestamp, then the server MUST answer `400 validation_error` naming the bound in `details`.

**Tests:** `compliance/occurrences.test.ts › refuses a bound that is no timestamp, naming which`.

### `occurrences/no-credential`

If `GET /occurrences` carries no credential, then the server MUST answer `401`.

**Tests:** `compliance/occurrences.test.ts › refuses a request with no credential`.

### `occurrences/type-map`

When `GET /occurrences` answers a credential whose type map reads some event types and not others, the server MUST leave out the occurrences of the events of the types it may not read.

**Reason:** the operation applies the credential's type map as `GET /items` does.

**Tests:** `compliance/unreadable-type-filter.test.ts › GET /occurrences answers the readable subtype of an event type the key may not read`.

### `occurrences/type-names`

When `GET /occurrences` names a `type`, the server MUST answer the events of that type and of the types under it, a type declared under `core.event` included, and of no other type.

**Tests:** `compliance/occurrences.test.ts › answers the events of the type it names, a type declared under core.event included`.

### `occurrences/source-filter`

Where the `enforcement.source_filter` that holds for the credential names a type of event and names sources, the server MUST leave out of `GET /occurrences` every occurrence of an event of that type, or of a type under it, whose source the filter does not name.

**Reason:** the filter narrows every read that returns a set (`types/source-filter`), and a window is a set to choose from.

**Tests:** `compliance/schema-enforcement.test.ts › leaves out of a window the events the instance's source filter does not admit`.

## How a series unfolds

### `occurrences/first-start`

The server MUST give a series its own `starts_at` as its first occurrence, whether or not its rule would produce that time, and follow it with the occurrences of its rule.

**Tests:** `compliance/recurrence.test.ts › counts its own start as the first occurrence and carries its length to each`.

### `occurrences/count-start`

When a series' rule carries a `COUNT`, the server MUST count the start among the occurrences, as RFC 5545 counts a series.

**Tests:** `compliance/recurrence.test.ts › counts its own start as the first occurrence and carries its length to each`.

### `occurrences/series-id`

The server MUST carry the `series_id` of its series on each occurrence it computes from a rule.

**Tests:** `compliance/recurrence.test.ts › counts its own start as the first occurrence and carries its length to each`.

### `occurrences/length-end`

When a series carries an `ends_at`, the server MUST give each occurrence the length from `starts_at` to `ends_at`, even where the series also carries a `duration`.

**Tests:** `compliance/recurrence.test.ts › counts its own start as the first occurrence and carries its length to each`, `› takes its length from its end rather than its duration when it states both`.

### `occurrences/length-duration`

When a series carries a `duration` and no `ends_at`, the server MUST give each occurrence a length of `duration` seconds.

**Tests:** `compliance/recurrence.test.ts › takes its length from duration when it states no end`.

### `occurrences/length-none`

When a series carries neither `ends_at` nor `duration`, the server MUST give each occurrence no `ends_at`.

**Tests:** `compliance/recurrence.test.ts › gives an occurrence no end when its series states neither an end nor a duration`.

### `occurrences/zone-local-hour`

When a series carries a `timezone`, the server MUST keep its local hour in that zone across a clock change, so its occurrences sit at a different UTC hour on either side of one.

**Tests:** `compliance/recurrence.test.ts › keeps its local hour across a clock change in its zone`.

### `occurrences/zone-none`

When a series carries no `timezone`, the server MUST advance it in UTC.

**Reason:** the offset a start was written with is only a spelling of an instant.

**Tests:** `compliance/recurrence.test.ts › advances a series with no timezone in UTC across a clock change`.

### `occurrences/until-utc`

When the `UNTIL` of a series' rule is in UTC, the server MUST end the series at that instant in every zone, east or west of UTC.

**Tests:** `compliance/recurrence.test.ts › ends a series at a UTC UNTIL's instant in %s`.

### `occurrences/exdate-instant`

When an `EXDATE` of a series is in UTC or carries a `TZID` naming any zone, the server MUST remove the occurrence at the instant it names.

**Tests:** `compliance/recurrence.test.ts › applies an EXDATE and an RDATE at their instants, in UTC or another zone`.

### `occurrences/rdate-instant`

When an `RDATE` of a series is in UTC or carries a `TZID` naming any zone, the server MUST add the occurrence at the instant it names.

**Tests:** `compliance/recurrence.test.ts › applies an EXDATE and an RDATE at their instants, in UTC or another zone`, `› reads an RDATE in UTC at the instant it names`.

### `occurrences/value-zoneless`

When an `UNTIL`, an `EXDATE` or an `RDATE` of a series carries no zone, the server MUST read it in the series' own zone.

**Tests:** `compliance/recurrence.test.ts › reads an EXDATE and an RDATE with no zone in the series' zone`, `› ends a series at an UNTIL with no zone, read in the series' zone`.

### `occurrences/exdate-day`

When an `EXDATE` of a series names a date with no time, the server MUST remove the occurrence on that day in the series' zone.

**Tests:** `compliance/recurrence.test.ts › removes the occurrence on the day a date-only EXDATE names, in the series' zone`.

### `occurrences/rdate-day`

When an `RDATE` of a series names a date with no time, the server MUST add an occurrence at the series' own time of day on that day in the series' zone.

**Tests:** `compliance/recurrence.test.ts › adds the occurrence at the series' own time of day on the day a date-only RDATE names`.

### `occurrences/gap-skipped`

When a series' occurrence falls at a local time that a clock change skips, the server MUST read it with the offset in force before the gap, so that it lands later by the length of the gap, and keep it.

**Tests:** `compliance/recurrence.test.ts › moves a skipped time later by the gap in %s`.

### `occurrences/gap-repeated`

When a series' occurrence falls at a local time that a clock change repeats, the server MUST take its first reading and keep the occurrence.

**Tests:** `compliance/recurrence.test.ts › takes the first of a repeated time in %s`.

### `occurrences/series-days`

When a series has `all_day: true`, the server MUST start each occurrence at local midnight in the series' zone and end it at local midnight as many days later as the first occurrence spans.

**Reason:** a day that a clock change shortens or lengthens is still one day.

**Tests:** `compliance/recurrence.test.ts › spans whole local days across a clock change`.

## A moved occurrence

### `occurrences/moved-replaces`

When an `active` event with an `original_starts_at` that the credential may read is joined to a series by a `parent-of` edge from the series, the server MUST show it in place of the series' occurrence at that instant.

**Tests:** `compliance/recurrence.test.ts › shows a moved occurrence only in the window its own times overlap`, `› carries series_id and replaces on a moved occurrence in a window that holds both times`.

### `occurrences/moved-ids`

When a moved occurrence is in a window, and its series is `active` and one the credential may read, the server MUST carry on it the `series_id` of its series and, in `replaces`, the start of the occurrence it replaces, whether or not the window holds that occurrence.

**Reason:** the exception names its series and the slot it replaced, wherever it is shown.

**Tests:** `compliance/recurrence.test.ts › carries series_id and replaces on a moved occurrence in a window that holds only its new time`, `› carries series_id and replaces on a moved occurrence in a window that holds both times`.

### `occurrences/moved-ids-hidden`

When a moved occurrence is in a window and its series is not one the credential may read, the server MUST answer it without `series_id` and without `replaces`.

**Reason:** the fields would name a row the credential may not read.

**Tests:** `compliance/recurrence.test.ts › names no series a moved occurrence belongs to when the series is not readable`.

### `occurrences/moved-own-times`

The server MUST show a moved occurrence at its own `starts_at` and `ends_at`.

**Tests:** `compliance/recurrence.test.ts › places a moved whole-day occurrence by its own days, in a window holding its slot and in one that does not`, `› shows a moved occurrence only in the window its own times overlap`.

### `occurrences/moved-slot-empty`

When a window holds the occurrence that an `active` stored exception the credential may read moved away, and not the exception's own times, the server MUST show nothing at that occurrence.

**Tests:** `compliance/recurrence.test.ts › shows a moved occurrence only in the window its own times overlap`.

### `occurrences/moved-once`

When a window overlaps a moved occurrence's own times, the server MUST show it once.

**Tests:** `compliance/recurrence.test.ts › shows a moved occurrence only in the window its own times overlap`, `› carries series_id and replaces on a moved occurrence in a window that holds both times`.

## A whole-day event

An event with `all_day: true` occupies whole days in its zone, whether it repeats or not. A bare date names its day.

### `occurrences/allday-zone`

When an event has `all_day: true`, whether or not it carries a `recurrence`, the server MUST place it from midnight of the day its `starts_at` names to midnight of the day its end names, in the event's `timezone`.

**Reason:** a day belongs to the zone it is lived in, so a single whole-day event and a repeating one on the same day must fall inside or outside the same windows, and a day that a clock change shortens or lengthens is still one day.

**Tests:** `compliance/recurrence.test.ts › places a whole-day event by its zone's midnights, single or repeating`.

### `occurrences/allday-utc`

When an event has `all_day: true` and names no `timezone`, the server MUST place it by midnights in UTC.

**Tests:** `compliance/recurrence.test.ts › places a whole-day event in UTC when it names no zone`.

### `occurrences/allday-instant`

When the `starts_at` of a whole-day event is an instant, the server MUST place the event on the day that instant falls on in the event's zone.

**Tests:** `compliance/recurrence.test.ts › places a whole-day event named by an instant on the day it falls on in its zone`.

### `occurrences/allday-end`

When a whole-day event carries an `ends_at`, the server MUST end it at midnight of the day the `ends_at` names.

**Tests:** `compliance/recurrence.test.ts › ends a whole-day event at midnight of the day its end names`.

### `occurrences/allday-duration`

When a whole-day event carries a `duration` and no `ends_at`, the server MUST end it after the days that the `duration` covers, rounded up.

**Tests:** `compliance/recurrence.test.ts › covers the days a whole-day event's duration reaches, rounded up, when it states no end`.

### `occurrences/allday-one-day`

When a whole-day event carries neither `ends_at` nor `duration`, the server MUST place it as one day long.

**Tests:** `compliance/recurrence.test.ts › places a whole-day event by its zone's midnights, single or repeating`.

### `occurrences/allday-end-early`

When the `ends_at` of a whole-day event names the day it starts on or an earlier one, the server MUST place it as one day long.

**Reason:** a whole-day event occupies the day it starts on, so a span with no length would leave it out of the windows that overlap that day.

**Tests:** `compliance/recurrence.test.ts › places a whole-day event as one day long when its end names its start day or an earlier one`.

### `occurrences/allday-duration-short`

When the `duration` of a whole-day event is under one day, the server MUST place it as one day long.

**Tests:** `compliance/recurrence.test.ts › places a whole-day event as one day long when its duration is under a day`.

### `occurrences/allday-window`

When a window is read, the server MUST read a whole-day event by the span that `occurrences/allday-zone` gives it.

**Reason:** a reading by the UTC midnights would leave the event out of a window that touches its day only at the zone's midnights, and put it in one that does not.

**Tests:** `compliance/recurrence.test.ts › places a whole-day event by its zone's midnights, single or repeating`.

## What a window includes

### `occurrences/window-overlap`

The server MUST include in a window every event that starts before the window ends and ends after it opens, as RFC 4791 reads a time range, an event or series occurrence that is already running when the window opens included.

**Tests:** `compliance/recurrence.test.ts › includes every event that overlaps it, and no event that ends as it opens`.

### `occurrences/window-ended`

The server MUST NOT include in a window an event that ends exactly as the window opens.

**Tests:** `compliance/recurrence.test.ts › includes every event that overlaps it, and no event that ends as it opens`.

### `occurrences/window-point-from`

When an event has no length, the server MUST include it in a window that starts at the instant the event starts.

**Tests:** `compliance/recurrence.test.ts › includes an event with no length where it starts, from inclusive and to exclusive`.

### `occurrences/window-point-to`

When an event has no length, the server MUST NOT include it in a window that ends at the instant the event starts.

**Tests:** `compliance/recurrence.test.ts › includes an event with no length where it starts, from inclusive and to exclusive`.

### `occurrences/window-event-end`

When an event carries no `ends_at`, the server MUST end it at its start plus its `duration` where it carries one.

**Tests:** `compliance/recurrence.test.ts › ends an event that states no end at its start plus its duration`.

## What a window may hold

### `occurrences/window-days`

If the window of `GET /occurrences` is longer than 400 days, then the server MUST answer `400 validation_error` with `details.max_days` of 400.

**Reason:** a window is refused and not trimmed, because the one move a caller knows is to ask for less.

**Tests:** `compliance/recurrence.test.ts › refuses a window longer than 400 days, and one holding more than 5000 occurrences`, `› takes a window of exactly 400 days and refuses one a millisecond longer`.

### `occurrences/window-days-taken`

The server MUST answer a window of exactly 400 days.

**Tests:** `compliance/recurrence.test.ts › takes a window of exactly 400 days and refuses one a millisecond longer`.

### `occurrences/window-count`

If a window holds more than 5,000 occurrences, then the server MUST answer `400 validation_error` with `details.max_occurrences` of 5000.

**Reason:** a window is refused and not trimmed, because a calendar that quietly lost a meeting would look like a correct one.

**Tests:** `compliance/recurrence.test.ts › refuses a window longer than 400 days, and one holding more than 5000 occurrences`, `› takes a window holding exactly 5000 occurrences and refuses one holding 5001`.

### `occurrences/window-count-taken`

The server MUST answer a window that holds exactly 5,000 occurrences.

**Tests:** `compliance/recurrence.test.ts › takes a window holding exactly 5000 occurrences and refuses one holding 5001`.

## Unfolding is bounded

A series whose rule cannot be unfolded within the server's bounds is left out of `data`, and the rest of the window answers.

### `occurrences/unfold-stopped`

If a series' rule considers more than 100,000 candidate times before its walk through the window ends, then the server MUST leave the series out of `data`.

**Tests:** `compliance/recurrence.test.ts › is stopped inside its walk and named, and the rest of the window answers`.

### `occurrences/unfold-too-long`

If a series takes more than 1,000 ms to unfold, then the server MUST leave the series out of `data`.

**Reason:** the time bound is a backstop that fires only on a slow machine, and the bound on candidate times fires first for any rule that is slow on an ordinary one.

**Tests:** waiting on #1444.

### `occurrences/unfold-per-series`

If a series has more than 2,000 occurrences in the window, then the server MUST leave the series out of `data`.

**Tests:** `compliance/recurrence.test.ts › says expansion_incomplete when a series has more occurrences in the window than it may unfold`.

### `occurrences/unfold-per-series-taken`

The server MUST unfold whole a series that has exactly 2,000 occurrences in the window.

**Tests:** `compliance/recurrence.test.ts › says expansion_incomplete when a series has more occurrences in the window than it may unfold`.

### `occurrences/unfold-named`

While `series_errors` holds fewer than 500 entries, when the server leaves a series out of `data` by `occurrences/unfold-stopped`, `occurrences/unfold-too-long` or `occurrences/unfold-per-series`, the server MUST name the series in `series_errors`.

**Tests:** `compliance/recurrence.test.ts › is stopped inside its walk and named, and the rest of the window answers`, `› says expansion_incomplete when a series has more occurrences in the window than it may unfold`, `compliance/unfold-budget.test.ts › answers expansion_incomplete and counts the series it never reached, naming none of them`.

### `occurrences/unfold-counted`

When the server leaves a series out of `data` by `occurrences/unfold-stopped`, `occurrences/unfold-too-long` or `occurrences/unfold-per-series`, the server MUST count it in `scan.series_unexpanded`.

**Tests:** `compliance/recurrence.test.ts › is stopped inside its walk and named, and the rest of the window answers`, `› says expansion_incomplete when a series has more occurrences in the window than it may unfold`, `compliance/unfold-budget.test.ts › answers expansion_incomplete and counts the series it never reached, naming none of them`.

### `occurrences/unfold-budget`

When the series of one `GET /occurrences` request that unfolded to no occurrence have together considered 2,000,000 candidate times, the server MUST count each series it has not yet reached in `scan.series_unexpanded`.

**Reason:** the bound keeps a calendar of costly rules from holding the request for each of them in turn. A series that unfolds to occurrences does not count toward it, so a full calendar does not reach it.

**Tests:** `compliance/unfold-budget.test.ts › answers expansion_incomplete and counts the series it never reached, naming none of them`.

### `occurrences/unfold-budget-unnamed`

The server MUST NOT name in `series_errors` a series that `occurrences/unfold-budget` left unreached.

**Reason:** an unreached series was never read, so nothing is known to be wrong with its rule. `scan.series_unexpanded` and `expansion_incomplete` say that the calendar is missing something.

**Tests:** `compliance/unfold-budget.test.ts › answers expansion_incomplete and counts the series it never reached, naming none of them`.

### `occurrences/unfold-incomplete`

When `scan.series_unexpanded` is above 0, the server MUST answer `expansion_incomplete` as `true`.

**Reason:** the calendar may be missing what the series held, and a stop that nobody is told about is a calendar quietly missing meetings.

**Tests:** `compliance/recurrence.test.ts › is stopped inside its walk and named, and the rest of the window answers`, `› says expansion_incomplete when a series has more occurrences in the window than it may unfold`, `compliance/unfold-budget.test.ts › answers expansion_incomplete and counts the series it never reached, naming none of them`.

### `occurrences/unfold-rest`

When the server leaves a series out of `data`, the server MUST answer the rest of the window with `200`.

**Tests:** `compliance/recurrence.test.ts › is stopped inside its walk and named, and the rest of the window answers`.

## What a write may store

An event's schedule is judged on every operation that writes an item's properties, `POST /items`, `PATCH /items/{id}`, `POST /items/bulk`, `POST /items/bulk-actions` with `update_properties` and `POST /restore`, and each refuses as it refuses any other property (`items/property-invalid`). A refusal is `400 invalid_properties` with `details.errors` naming the field.

### `occurrences/schedule-unreadable`

If an event's `recurrence` holds a line that cannot be read, such as a rule with no `FREQ`, a `COUNT` with an `UNTIL` or a part that is not defined, then the server MUST refuse the write and name `recurrence`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-exrule`

If an event's `recurrence` holds an `EXRULE`, then the server MUST refuse the write and name `recurrence`.

**Reason:** the server does not apply an `EXRULE`, and a rule that is not applied as written is refused.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-period`

If an event's `recurrence` holds an `RDATE` period, then the server MUST refuse the write and name `recurrence`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-part`

If an event's `recurrence` holds a part that RFC 5545 does not define for the rule's frequency, such as a numbered weekday on a weekly rule, then the server MUST refuse the write and name `recurrence`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-no-date`

If an event's `recurrence` names no date that exists after the start, such as the 30th of February, then the server MUST refuse the write and name `recurrence`, even where the rule counts more than one occurrence.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-no-unfold`

If an event's `recurrence` produces no occurrence after the start within the bound that a read unfolds a rule to, then the server MUST refuse the write and name `recurrence`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-no-start`

If an event carries a `recurrence` and no `starts_at` to unfold it from, then the server MUST refuse the write and name `recurrence`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-second-rule`

If an event's `recurrence` holds a second `RRULE`, then the server MUST refuse the write and name `recurrence`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-dates`

If an event's `recurrence` adds and removes more than 1,000 dates together, then the server MUST refuse the write and name `recurrence`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-text`

If an event's `recurrence` is longer than 40,000 characters in all, then the server MUST refuse the write and name `recurrence`, before it reads any line.

**Tests:** `compliance/recurrence.test.ts › refuses a recurrence over 40,000 characters in all and takes one of exactly 40,000`.

### `occurrences/schedule-text-taken`

The server MUST take an event whose `recurrence` is exactly 40,000 characters in all.

**Tests:** `compliance/recurrence.test.ts › refuses a recurrence over 40,000 characters in all and takes one of exactly 40,000`.

### `occurrences/schedule-zone`

If an event's `timezone` is not a named zone that the zone database resolves, then the server MUST refuse the write and name `timezone`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-end-zone`

If an event's `end_timezone` is not a named zone that the zone database resolves, then the server MUST refuse the write and name `end_timezone`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-duration-low`

If an event's `duration` is below 0, then the server MUST refuse the write and name `duration`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-duration-high`

If an event's `duration` is more than 3,162,240,000 seconds, a century of 366-day years, then the server MUST refuse the write and name `duration`.

**Tests:** `compliance/recurrence.test.ts › refuses %s, naming the field`.

### `occurrences/schedule-allday-hours`

If an event with `all_day: true` carries a `recurrence` that repeats by hours, minutes or seconds, or names hours, minutes or seconds, then the server MUST refuse the write and name `recurrence`.

**Reason:** a whole-day series repeats by days or longer.

**Tests:** `compliance/recurrence.test.ts › refuses a rule that repeats by hours, minutes or seconds, and takes one that repeats by days`.

### `occurrences/schedule-allday-days`

The server MUST take a whole-day event whose `recurrence` repeats by days.

**Tests:** `compliance/recurrence.test.ts › refuses a rule that repeats by hours, minutes or seconds, and takes one that repeats by days`.

### `occurrences/schedule-taken`

Where no rule above refuses an event's schedule, the server MUST take the event whether its rule ends by its own `COUNT` or `UNTIL`, its zone is a fixed offset such as `Etc/GMT+5`, or its rule names a day that only some years have, such as the 29th of February.

**Tests:** `compliance/recurrence.test.ts › takes the nearest rule each of those refusals turns away`, `› takes an ordinary series, a fixed-offset zone and a leap day`.

### `occurrences/schedule-update`

If a `PATCH /items/{id}` adds a schedule that the rules above refuse, then the server MUST refuse it as `POST /items` does.

**Tests:** `compliance/recurrence.test.ts › refuses the same rule added by an update or a bulk write, and stores none of it`.

### `occurrences/schedule-bulk`

If a `POST /items/bulk` entry of a page under `atomic: false` adds a schedule that the rules above refuse, then the server MUST report that entry `errored` with the code `invalid_properties`.

**Reason:** the refusal is the row's and not the page's.

**Tests:** `compliance/recurrence.test.ts › refuses the same rule added by an update or a bulk write, and stores none of it`.

### `occurrences/schedule-bulk-action`

If a `POST /items/bulk-actions` job with `update_properties` writes a schedule that the rules above refuse, then the server MUST record the refusal in that row's entry of the job's `errors` with the code `invalid_properties`.

**Tests:** `compliance/recurrence.test.ts › refuses it on a bulk-action patch per row, and in a restored archive`.

### `occurrences/schedule-restore`

If an archive holds an event with a schedule that the rules above refuse, then the server MUST refuse the archive `400 invalid_properties` naming `recurrence`.

**Tests:** `compliance/recurrence.test.ts › refuses it on a bulk-action patch per row, and in a restored archive`, `compliance/restore-archive.test.ts › leaves no row, type, edge type, blob, event or audit record behind when a later row is refused`.
