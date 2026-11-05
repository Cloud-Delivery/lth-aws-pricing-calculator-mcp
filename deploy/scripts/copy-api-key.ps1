param(
    [string]$StackName = 'LthAwsPricingMcpStack',
    [switch]$ClearClipboard
)

$ErrorActionPreference = 'Stop'
if ($ClearClipboard) {
    Set-Clipboard -Value ''
    Write-Output 'Clipboard cleared.'
    exit 0
}

$identityJson = & aws sts get-caller-identity --profile lutechlab-sandbox --region eu-south-1 --output json --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Could not verify AWS identity.' }
$identity = $identityJson | ConvertFrom-Json
if ($identity.Account -ne '695076071513') { throw 'Unexpected AWS account; key retrieval stopped.' }

$stackJson = & aws cloudformation describe-stacks --stack-name $StackName --profile lutechlab-sandbox --region eu-south-1 --output json --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Could not read stack outputs.' }
$outputs = ($stackJson | ConvertFrom-Json).Stacks[0].Outputs
$apiUrl = ($outputs | Where-Object OutputKey -eq 'ApiUrl').OutputValue
$keyId = ($outputs | Where-Object OutputKey -eq 'ApiKeyId').OutputValue
if (-not $apiUrl -or -not $keyId) { throw 'Stack does not expose ApiUrl and ApiKeyId.' }

$keyJson = & aws apigateway get-api-key --api-key $keyId --include-value --profile lutechlab-sandbox --region eu-south-1 --output json --no-cli-pager
if ($LASTEXITCODE -ne 0) { throw 'Could not retrieve API key; check operator IAM permissions.' }
$key = $keyJson | ConvertFrom-Json
if (-not $key.enabled -or -not $key.value) { throw 'API key is disabled or has no value.' }
Set-Clipboard -Value $key.value
$keyJson = $null
$key = $null
Write-Output "API URL: $apiUrl"
Write-Output "API key ID: $keyId"
Write-Output 'API key value copied to clipboard, not printed. Paste only into the protected connection field.'
Write-Output 'Clear the clipboard immediately after use; avoid clipboard history/synchronization.'
