param(
    [Parameter(Mandatory, ValueFromRemainingArguments)]
    [string[]]$CdkArguments
)

$ErrorActionPreference = 'Stop'
if ($CdkArguments | Where-Object { $_ -match '^--profile(?:=|$)' }) {
    throw 'Do not pass --profile: this wrapper uses verified lutechlab-sandbox credentials.'
}

$names = @('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION')
$saved = @{}
foreach ($name in $names) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$location = Get-Location
try {
    $raw = & aws configure export-credentials --profile lutechlab-sandbox --format process
    if ($LASTEXITCODE -ne 0) { throw 'Credential export failed; run aws sso login --profile lutechlab-sandbox.' }
    $credentials = $raw | ConvertFrom-Json
    if (-not $credentials.AccessKeyId -or -not $credentials.SecretAccessKey -or -not $credentials.SessionToken) {
        throw 'AWS CLI did not return complete temporary credentials.'
    }
    $env:AWS_ACCESS_KEY_ID = $credentials.AccessKeyId
    $env:AWS_SECRET_ACCESS_KEY = $credentials.SecretAccessKey
    $env:AWS_SESSION_TOKEN = $credentials.SessionToken
    foreach ($name in @('AWS_PROFILE', 'AWS_DEFAULT_PROFILE')) {
        if (Test-Path "Env:$name") { Remove-Item "Env:$name" }
    }
    $env:AWS_REGION = 'eu-south-1'
    $env:AWS_DEFAULT_REGION = 'eu-south-1'
    $identityJson = & aws sts get-caller-identity --region eu-south-1 --output json --no-cli-pager
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify exported AWS credentials.' }
    if (($identityJson | ConvertFrom-Json).Account -ne '695076071513') {
        throw 'Unexpected AWS account; CDK stopped.'
    }
    Set-Location (Join-Path $PSScriptRoot '..')
    & npm run cdk -- @CdkArguments
    $result = $LASTEXITCODE
} finally {
    foreach ($name in $names) {
        if ($null -eq $saved[$name]) {
            if (Test-Path "Env:$name") { Remove-Item "Env:$name" }
        } else {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
        }
    }
    $raw = $null
    $credentials = $null
    Set-Location $location
}
exit $result
