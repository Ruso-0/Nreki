#
# NREKI landing-page demo tape — produces docs/demo.gif.
#
# Prereqs:
#   1. npm install          (installs tsx + deps)
#   2. Install vhs:         https://github.com/charmbracelet/vhs
#        brew install vhs   /  choco install vhs  /  go install github.com/charmbracelet/vhs@latest
#   3. vhs scripts/demo.tape
#

Output docs/demo.gif

Set Shell      "bash"
Set FontSize   16
Set Width      1100
Set Height     500
Set Theme      "Dracula"
Set Padding    20
Set TypingSpeed 40ms

# Hide the terminal priming — viewers land on a clean prompt.
Hide
Type "clear"
Enter
Sleep 200ms
Show

# Cue the value prop. A short delay so readers catch the command.
Sleep 600ms
Type "npx tsx scripts/demo-outline.ts"
Sleep 400ms
Enter

# First-time tsx transform takes ~2s on cold cache; the engine boot +
# outline itself is < 100ms. Leave room for the viewer to read the tags.
Sleep 6s
