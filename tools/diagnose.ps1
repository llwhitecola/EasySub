# Run by smoke_test.py when the window never came up, to tell a broken exe from a broken machine.
# ASCII only: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.
param([string]$Shot = "")

"--- WebView2 runtime"
$client = "Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
foreach ($root in "HKLM:\SOFTWARE\WOW6432Node", "HKLM:\SOFTWARE", "HKCU:\Software") {
    $pv = (Get-ItemProperty "$root\$client" -ErrorAction SilentlyContinue).pv
    "$root : $(if ($pv) { $pv } else { 'not installed' })"
}

"--- .NET Framework release"
(Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" -ErrorAction SilentlyContinue).Release

"--- processes"
Get-CimInstance Win32_Process -Filter "Name LIKE 'EasySub%' OR Name LIKE 'msedgewebview2%'" |
    Where-Object { "$($_.CommandLine)" -match "EasySub" -and "$($_.CommandLine)" -notmatch "--type=" } |
    ForEach-Object {
        $cmd = "$($_.CommandLine)"
        "$($_.ProcessId) <- $($_.ParentProcessId) $($_.Name) $($cmd.Substring(0, [Math]::Min(400, $cmd.Length)))"
    }

"--- windows"
Get-Process EasySub* -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.ProcessName): $($_.MainWindowTitle)" }

"--- listening ports of EasySub"
$ids = (Get-Process EasySub* -ErrorAction SilentlyContinue).Id
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }

# The whole desktop is only worth capturing on a throwaway CI machine.
if ($Shot -and $env:GITHUB_ACTIONS) {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [Windows.Forms.SystemInformation]::VirtualScreen
    $image = New-Object Drawing.Bitmap $b.Width, $b.Height
    [Drawing.Graphics]::FromImage($image).CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
    $image.Save($Shot)
    "--- desktop saved to $Shot ($($b.Width)x$($b.Height))"
}
