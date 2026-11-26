# voyage-key-dialog.ps1 - the box `nreki init` shows on Windows to ask for the
# Voyage API key. NREKI passes the texts as JSON in $env:NREKI_DIALOG (so this
# file stays ASCII) and reads one JSON line from stdout:
#   {"action":"key","key":"..."} | {"action":"use-saved"} | {"action":"local"} | {"action":"skip"}
# The key is never written anywhere by this script.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$cfg = $env:NREKI_DIALOG | ConvertFrom-Json
$script:result = @{ action = "skip" }

# A launcher can ask Windows to hide this process's first window (SW_HIDE in
# STARTUPINFO); Windows applies it to the first ShowWindow call. Spend that
# call on an invisible throwaway window so the real box always shows.
$spent = New-Object System.Windows.Forms.Form
$spent.ShowInTaskbar = $false
$spent.Opacity = 0
$spent.FormBorderStyle = "None"
$spent.Size = New-Object System.Drawing.Size(1, 1)
$spent.Show()
$spent.Hide()
$spent.Dispose()

$form = New-Object System.Windows.Forms.Form
$form.Text = $cfg.title
$form.ClientSize = New-Object System.Drawing.Size(520, 236)
$form.StartPosition = "CenterScreen"
$form.TopMost = $true
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$message = New-Object System.Windows.Forms.Label
$message.Text = $cfg.message
$message.Location = New-Object System.Drawing.Point(16, 12)
$message.Size = New-Object System.Drawing.Size(490, 92)

$field = New-Object System.Windows.Forms.TextBox
$field.UseSystemPasswordChar = $true
$field.Location = New-Object System.Drawing.Point(16, 110)
$field.Size = New-Object System.Drawing.Size(488, 28)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(16, 144)
$status.Size = New-Object System.Drawing.Size(490, 44)
$status.ForeColor = "DarkRed"
if ($cfg.error) { $status.Text = $cfg.error }

$primary = New-Object System.Windows.Forms.Button
$primary.Text = $cfg.primary
$primary.Location = New-Object System.Drawing.Point(244, 194)
$primary.Size = New-Object System.Drawing.Size(150, 32)

$secondary = New-Object System.Windows.Forms.Button
$secondary.Text = $cfg.secondary
$secondary.Location = New-Object System.Drawing.Point(404, 194)
$secondary.Size = New-Object System.Drawing.Size(100, 32)

$primary.Add_Click({
    $key = $field.Text.Trim()
    if ($key) {
        $script:result = @{ action = "key"; key = $key }
    } elseif ($cfg.hasSavedKey) {
        $script:result = @{ action = "use-saved" }
    } else {
        $status.Text = $cfg.emptyField
        return
    }
    $form.Close()
})
$secondary.Add_Click({
    $script:result = @{ action = "local" }
    $form.Close()
})

$form.AcceptButton = $primary
$form.Controls.AddRange(@($message, $field, $status, $primary, $secondary))
$form.Add_Shown({ $form.Activate(); $field.Focus() })
[void]$form.ShowDialog()

[Console]::Out.WriteLine(($script:result | ConvertTo-Json -Compress))
