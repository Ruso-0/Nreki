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
Set FontSize   15
Set Width      1200
Set Height     720
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

# Three scenes in ~5-7s of actual work (engine boot ~1s; two outlines
# ~40ms each; spectral topology on 116 zod files ~400ms + ~60ms Fiedler).
# tsx cold-transform adds ~2s. Total sleep lets viewers read all three.
Sleep 12s
