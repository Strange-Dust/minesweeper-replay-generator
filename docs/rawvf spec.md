# RawVF Specification

Revision: 7

See original reference here: https://minesweepergame.com/forum/viewtopic.php?t=86

Updated in 2026 to document various changes necessary to modernize the format.


## 1. File Layout

```text
<video> ::= <description> <board> <events>
```

A RawVF file is three sections in order:

1. Description section (key/value options)
2. Board section (`Board:` + mine grid)
3. Events section (`Events:` + event lines)

In order to accomodate multiple games in the same file, these sections can be repeated.

## 2. Description Section

```text
<description> ::= <option> <description> | <option>
<option>      ::= <optionname>: <optionvalue>
<optionname>  ::= {non-empty string without ':'}
<optionvalue> ::= {string}
```

The description section is a list of lines in `Key: Value` format.

The exact information included varies widely, based on specific implementation.

Optionally, the description section can start with a literal header line:

```text
Description:
```


## 3. Board Section

```text
<board> ::= Board:\n <grid>
<grid>  ::= <row> <grid> | <row>
<row>   ::= <mine><row> | <safe><row> | <mine>\n | <safe>\n
<mine>  ::= *
<safe>  ::= 0
```

Board section starts with a header line:

```text
Board:
```

Then a grid of rows:

- `*` means mine
- `0` means safe

Note:

- Row count should match `Height`.
- Column count should match `Width`.

## 4. Events Section

```text
<events>    ::= Events:\n <eventlist>
<eventlist> ::= <event> <eventlist> | <event>
<event>     ::= <mouse_event> | <board_event> | <game_event> | <scrolling_event> | <board_reset_event>
```

Events section starts with a literal header line:

```text
Events:
```

After that, each line is one event.  Exception: board change event.

### 4.1 Mouse Event

```text
<mouse_event> ::= <elapsed_time> <mouse_event_id> [column] [row] (<coord_x> <coord_y>) [(<mouse_state>)]\n
<elapsed_time> ::= <second>.<hundredth> | <second>.<thousandth> | -<second>.<hundredth> | -<second>.<thousandth>
<mouse_event_id> ::= <left_click> | <left_release> | <right_click> | <right_release> | <middle_click> | <middle_release> | <mouse_move> | <left_click_with_shift> | <toggle_question_mark_setting>
<left_click> ::= lc 
<left_release> ::= lr 
<right_click> ::= rc 
<right_release> ::= rr 
<middle_click> ::= mc 
<middle_release> ::= mr 
<mouse_move> ::= mv
<left_click_with_shift> ::= sc
<toggle_question_mark_setting> ::= mt
<mouse_state> ::= [<left_pressed>][<right_pressed>][<middle_pressed>]
<left_pressed> ::= l
<right_pressed> ::= r
<middle_pressed> ::= m
```

Mouse events are composed of 4 parts:
- time
- event ID
- column & row coordinates
- X, Y coordinates

#### Time format:

```text
<elapsed_time> ::= <second>.<hundredth>
				 | <second>.<thousandth>
				 | -<second>.<hundredth>
				 | -<second>.<thousandth>
```

Time in seconds, with 3 decimal places.

#### Mouse event IDs:

- `lc` left click down
- `lr` left release
- `rc` right click down
- `rr` right release
- `mc` middle click down
- `mr` middle release
- `mv` mouse move
- `sc` left click with shift
- `mt` toggle question-mark setting

Question marks are generally not used by players, but they are maintained for backwards compatibility.


#### Mouse state:

```text
<mouse_state>    ::= [<left_pressed>][<right_pressed>][<middle_pressed>]
<left_pressed>   ::= l
<right_pressed>  ::= r
<middle_pressed> ::= m
```

Mouse states are not typically part of rawvf replays, but maybe someday they might be.


### 4.2 Board Event

```text
<board_event>    ::= <board_event_id> <column> <row>\n
<board_event_id> ::= <number> | <unopened>
<number>         ::= number0 | number1 | number2 | number3 | number4 | number5 | number6 | number7 | number8
<unopened>       ::= closed | flag | pressed | questionmark | pressedqm | blast | reset 
```

Board events are optional.  A replay without board events included will require a Minesweeper game simulation in order to recreate what happened during the game.

Board events use the time of the preceeding mouse event.

A board event represents something happening on the board, as a result of player actions.

For example, when revealing all the cells of an opening, the board events will include which number is revealed, and the grid (column, row) coordinates for each cell revealed.

Board Events:
- `number#` a cell is revealed, showing this number
- `closed` a cell returns to unrevealed state
- `flag` a flag is placed on a cell
- `pressed` an unrevealed cell is in the "pressed" state, ready to become revealed
- `questionmark` a question mark is placed on a cell
- `pressedqm` same as pressed, except the cell has a question mark
- `blast` a cell with a mine has been revealed
- `reset` a cell is returned to its unrevealed state, with mine presence data re-randomized

Notes:
* Note 1: the terms "closed" and "unrevealed" are treated as synonyms.
* Note 2: when a flag, or question mark, is removed, it is by using the `closed` event.
* Note 3: when a question mark becomes "unpressed", it is by using the `pressedqm` event.
* Note 4: a `reset` event implies that the cell also becomes `closed`.


### 4.3 Game Event

```text
<game_event>    ::= <elapsed_time> <game_event_id>\n
<game_event_id> ::= start | blast | boom | lost | defeat | won | nonstandard
```

The elapsed time is optional.  If not present, the time of the preceeding mouse event is used.

Game Event IDs:
- `start` the timer has started and the game has begun
- `lost` the player has revealed a mine, and the game is a loss
  - `boom` alternative to lost
  - `blast` alternative to lost
- `defeat` the player was defeated in PVP
- `won` the player has revealed all safe tiles, and the game is a win
- `nonstandard` the game ended for a reason other than a win or loss
  - Common causes: board reset mid-game, program crash, incomplete recording


### 4.4 Scrolling Event

```text
<scrolling_event> ::= <elapsed_time> <scrolled_axis> <position_horizontal> <position_vertical>
<scrolled_axis>   ::= sx | sy
```

Scrolling events are not currently known to be used in any replay format, but maybe someday they might be.


### 4.5 Board Change Event

A board change event can be used for game modes in which mine locations may change during game play.

Use the same header and format as described in the `Board` section.

Then, include the `Events:` header again, to indicate that the events are resuming.

Note: a Board change does not imply that all of the cells become closed; individual events for each cell are required if there are cells that change their current state.


## List of Description Options

The description options are very flexible.  

The items in the description are not required to follow the exact order here.

Options that can be `on` or `off` are treated as `off` if not present.

- Main Options
  - RawVF_Version: version number of RawVF format
  - Program: clone name
  - Version: version name
  - Player: player name
  - Timestamp: date and time
  - Level: level name
  - Width: board width
  - Height: board height
  - Mines: number of mines
  - Skin: skin name
  - Style: NF/FL/Eff
  - Time: duration of game, in seconds with 3 decimal places
  - URL: if played on a website, the URL for the game
  - Status: won/lost
  - BBBV: 3BV of board
  - BBBVS: 3BV/s
- Settings
  - Marks: `on/off` question marks 
  - SquareSize: size (in pixels) of a square. if none, default is 16.
  - Mode: classic/ng/lucky/density/upk/cheat
  - BoardEvents: `on/off` indicates whether or not the file includes board events
- Cheat Settings
  - Lives: number of lives
  - Autoflag: `on/off` auto flag squares which are known mines
  - Lawnmower: `on/off` flag all mines on first click
  - ElmarTechnique: `on/off` left click as left click+left release
  - NonoMouse: `on/off` mouse movement with pressed button counted as click
  - SuperFlag: `on/off` right click on opened square as autoflag
  - SuperClick: `on/off` left click on opened square as chord (L-Chord)
- Protection
  - Checksum: checksum

Strictly speaking, no options are truly mandatory.  It is recommended to include at least:
* width
* height
* mines
* level
* mode


## Explanations of Options

Anything not included here is because it is self-explanatory (example: player name).

### Timestamp

Date and time that the game was played.

There are different formats for timestamps, depending on the implementation:
* Unix Epoch
* ISO-8601
* Other

It is strongly recommended to use ISO-8601 with UTC timezone.

### Level

Classic:
* Beginner 
* Intermediate
* Expert
* Custom

No Guess:
* Easy
* Medium
* Hard
* Evil
* Custom


### Style
* `FL` Flag
* `NF` No Flag
* `Eff` Efficiency (`IOE >= 1.0`)


## Board Changes

There are some specific cases in which the configuration of the board may change:
* PVP modes in which the games are played back-to-back in "best of #" format
* PVP modes in which blasts are handled by resetting a nearby area of the board
* Modes such as "mean openings" in which additional mines may be placed

RawVF is a flexible format, so the exact way to handle specific cases depends heavily on the data available.

If the amount of mines or dimensions of the board change, it is not necessary to include the new values as they would appear in a description block, because the data can be recovered from the board block.


### PVP - Best of #

This case is handled by including a literal header line for the description:

```text
Description:
```

Then, include the data for the next game.

Repeat as necessary for multiple games.


### PVP - Local Reset

This case can be handled with board events of the cell reset (`reset`) type.

If preferred, a board change event can also be used, but it will require knowing the new mine locations.

