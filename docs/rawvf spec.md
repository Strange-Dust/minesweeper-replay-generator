# RawVF

## Overall Structure
<video> ::= <description> <board> <events>

## Description Structure
<description> ::= <option> <description> | <option>
<option> ::= <optionname>: <optionvalue>\n
<optionname> ::= {non-empty string without :}
<optionvalue> ::= {string}

## Board Structure
<board> ::= Board:\n <grid>
<grid> ::= <row> <grid> | <row>
<row> ::= <mine><row> | <safe><row> | <mine>\n | <safe>\n
<mine> ::= *
<safe> ::= 0

## Events
<events> ::= Events:\n <eventlist>
<eventlist> ::= <event> <eventlist> | <event>
<event> ::= <mouse_event> | <board_event> | <game_event> | <scrolling_event>

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

<board_event> ::= <board_event_id> <column> <row>\n
<board_event_id> ::= <number> | <unopened>
<number> ::= number0 | number1 | number2 | number3 | number4 | number5 | number6 | number7 | number8
<unopened> ::= closed | flag | pressed | questionmark | pressedqm | blast

<game_event> ::= <elapsed_time> <game_event_id>\n
<game_event_id> ::= start | boom | won | nonstandard

<scrolling_event> ::= <elapsed_time> <scrolled_axis> <position_horizontal> <position_vertical>
<scrolled_axis> ::= sx | sy


# Description Example
RawVF_Version: version number of RawVF format
Program: clone name
Version: version name
Player: player name
Timestamp: date and time
Level: level name
Width: board width
Height: board height
Mines: number of mines
Skin: skin name
Mode: classic/lucky/density/upk/cheat
--- settings ---
Marks: question marks on/off
--- cheat settings ---
Lives: number of lives
Autoflag: auto flag squares which are known mines on/off
Lawnmower: flag all mines on first click on/off
ElmarTechnique: left click as left click+left release on/off
NonoMouse: mouse movement with pressed button counted as click on/off
SuperClick: left click on opened square as chord on/off
SuperFlag: right click on opened square as autoflag on/off
SquareSize: size (in pixels) of a square. if none, default is 16.
--- protection ---
Checksum: 

