# UAT K0: baseline of the installed app

Reader: the UAT operator (a Codex agent) driving `~/Applications/Terax Pi.app` on macOS. Result file: `research/uat/<date>-baseline.md` in the efficient-pi repo. Operator line in the result: "driver-run, coordinator-briefed".

Driver: resolve an element by its accessibility name (osascript, System Events, process "terax", the AXWebArea subtree only), click the centre of its rect with `cliclick c:x,y`, type with `cliclick t:"..."`, press keys with `cliclick kp:return`, capture state with `screencapture -x -R 0,30,1707,1410 <shot>`. Never index the accessibility tree by position; never match native window controls (close, minimise, zoom). Keep every shot under `research/uat/shots/<date>-baseline/` in the efficient-pi repo. Never assert on the "% cached" text: the oMLX 4096-token block floor prints "0% cached" on short prompts.

Ids resolve today by accessibility name: [uat:settings-button] "Settings"; [uat:toggle-sidebar] "Toggle sidebar"; [uat:new-tab] "New tab"; [uat:composer-input] "pi composer"; [uat:attach-images] "Attach images"; [uat:usage-footer] text beginning "Worked"; [uat:terminal-composer-toggle] text "Composer".

Rows (Given / When / Then / Evidence):

0. TCC preflight. When I run `cliclick p`, then it prints the pointer position with no accessibility warning. Evidence: command output.
1. Given the app opened on the project, when I read `<project>/.pi/launcher.log`, then it holds the four prepare steps and no FAIL line. Evidence: file.
2. When I read the window title and the selected tab, then the title is "Terax" and the selected tab radio is named "pi Close tab" (the title does not carry the tab name). Shot: 02-title.png.
3. When I resolve [uat:settings-button], [uat:toggle-sidebar], [uat:new-tab] by accessibility name, then each returns a role and a rect. Evidence: JSON output.
4. When I click [uat:settings-button], then the Settings panel shows the pi binary, the agent, the agent dir and a provider row. Shot: 04-settings.png. Close Settings afterwards.
5. Given the chat tab active, when I click [uat:composer-input], type "List the files in this folder in one line" and press Enter (a prompt that makes a tool call, so the fold has rows), then a user block appears, then an answer block with an activity fold and [uat:usage-footer]. Shot: 05-turn.png.
6. When I click the fold text beginning "Worked", then the tool rows expand under it. Shot: 06-fold.png.
7. When I expand the Sessions rail pane, then past sessions list with prompts and token counts. Shot: 07-sessions.png.
8. When I open the board pane, then one column per state renders with the seeded tickets. Shot: 08-board.png (visual only).
9. When I attach a small PNG through [uat:attach-images] (or paste it into the composer) and send "describe the attached image in five words", then a chip appears on the user block and `<project>/.pi/attachments/<turn>-<n>.jpg` exists (the composer re-encodes pasted images as JPEG). Shot: 09-attached.png plus the file path.
10. Given a new terminal tab, when I run `echo uat-baseline` then `false`, then one block carries a green dot and the text, a second carries a red dot. Shot: 10-terminal.png.
11. Given an answer block, when I click "Open in editor", then a file appears under `<project>/.pi/answers/`. Shot: 11-editor.png plus the file path.

Break attempts (after the rows, each with a note): send an empty prompt; send while the previous turn is streaming; resize the window to 900 px wide; press Escape during a turn; click Reveal on the attachment chip; open a second terminal tab and close the first.

Result file format: a table with columns row, result (PASS, FAIL, BLOCKED), evidence path, note; every FAIL row names the log path checked (`<project>/.pi/launcher.log` or the app log); a free-form section "Break attempts"; a verdict line.
