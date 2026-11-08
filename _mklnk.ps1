$ErrorActionPreference = "Stop"
$src = "C:\Users\17321\dsh-plugin-snapshot"
Write-Output ("源文件存在: " + (Test-Path (Join-Path $src "发布到npm.bat")))
$desk = [Environment]::GetFolderPath("Desktop")
Write-Output ("桌面路径: " + $desk)
$sh = New-Object -ComObject WScript.Shell
foreach ($pair in @(@("发布到npm.bat", "1-发布到npm.lnk"), @("提PR.bat", "2-明天提PR.lnk"))) {
  $target = Join-Path $src $pair[0]
  if (-not (Test-Path $target)) { Write-Output ("缺失: " + $target); continue }
  $lnk = Join-Path $desk $pair[1]
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = $target
  $s.WorkingDirectory = $src
  $s.Description = "DSH plugin publish"
  $s.Save()
  Write-Output ("已创建: " + $lnk)
}

