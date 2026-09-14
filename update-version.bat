@echo off
powershell -ExecutionPolicy Bypass -Command "$yy=(Get-Date).Year.ToString().Substring(2);$mmdd=(Get-Date).ToString('MMdd');$v='1.'+$yy+'.'+$mmdd;Set-Content VERSION $v;Write-Output ('VERSION updated to '+$v)"
