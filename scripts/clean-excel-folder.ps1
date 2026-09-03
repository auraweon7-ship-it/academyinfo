param(
  [Parameter(Mandatory = $true)][string]$SourceFolder,
  [string]$FileName = ''
)

$ErrorActionPreference = 'Stop'
$exceptions = @(
  '고려대학교', '고려대학교(세종)_분교',
  '건국대학교', '건국대학교(글로컬)_분교',
  '동국대학교', '동국대학교(WISE)_분교',
  '연세대학교', '연세대학교(미래)_분교',
  '한양대학교', '한양대학교(ERICA)_분교'
)

function Normalize-SchoolName([string]$Name) {
  $value = ($Name -replace '\s+', ' ').Trim()
  if ($exceptions -contains $value) { return $value }
  $value = $value -replace '\s*_제[2-4]캠퍼스\s*$', ''
  $value = $value -replace '\s*\([^\)]+\)\s*(?:_캠퍼스)?\s*$', ''
  return $value.Trim()
}

function Get-HeaderText($Sheet, [int]$Column, [int]$HeaderStart, [int]$HeaderEnd) {
  $parts = New-Object System.Collections.Generic.List[string]
  for ($row = $HeaderStart; $row -le $HeaderEnd; $row++) {
    $cell = $Sheet.Cells.Item($row, $Column)
    $text = ''
    if ($cell.MergeCells) { $text = [string]$cell.MergeArea.Cells.Item(1, 1).Text }
    else { $text = [string]$cell.Text }
    $text = ($text -replace "`r?`n", ' ' -replace '\s+', ' ').Trim()
    if ($text -and -not $parts.Contains($text)) { $parts.Add($text) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($cell)
  }
  return ($parts -join ' / ')
}

function Find-SheetLayout($Sheet, [int]$RowCount, [int]$ColumnCount) {
  $scanRows = [math]::Min(15, $RowCount)
  $schoolColumn = 0; $schoolHeaderRow = 0
  for ($row = 1; $row -le $scanRows -and -not $schoolColumn; $row++) {
    for ($column = 1; $column -le $ColumnCount; $column++) {
      $text = ([string]$Sheet.Cells.Item($row, $column).Text -replace "`r?`n", '' -replace '\s+', '').Trim()
      if ($text -match '^(학교|학교명|대학명)$') { $schoolColumn = $column; $schoolHeaderRow = $row; break }
    }
  }
  if (-not $schoolColumn) { return $null }
  $dataStart = 0
  for ($row = $schoolHeaderRow + 1; $row -le $RowCount; $row++) {
    $school = ([string]$Sheet.Cells.Item($row, $schoolColumn).Text).Trim()
    $numericCount = 0
    for ($column = 1; $column -le $ColumnCount; $column++) {
      if (Is-Number $Sheet.Cells.Item($row, $column).Value2) { $numericCount++ }
    }
    if ($school -and $school -notmatch '^(학교|학교명|대학명|남|여|계|과제|연구비)$' -and $numericCount -ge 3) { $dataStart = $row; break }
  }
  if (-not $dataStart) { return $null }
  $headerStart = 1
  for ($row = 1; $row -le $schoolHeaderRow; $row++) {
    $nonEmpty = 0; $hasHeaderLabel = $false
    for ($column = 1; $column -le $ColumnCount; $column++) {
      $text = ([string]$Sheet.Cells.Item($row, $column).Text).Trim()
      if ($text) { $nonEmpty++ }
      if ($text -match '학교|기준연도|설립|지역|상태|교원|학생|연구비|과제') { $hasHeaderLabel = $true }
    }
    if ($hasHeaderLabel -and $nonEmpty -gt 1) { $headerStart = $row; break }
  }
  return [pscustomobject]@{ SchoolColumn = $schoolColumn; HeaderStart = $headerStart; HeaderEnd = $dataStart - 1; DataStart = $dataStart }
}

function Get-OutputTitle([string]$OriginalTitle, [string]$FileName) {
  if ($OriginalTitle -and $OriginalTitle -notmatch '^(기준연도|학교종류|학교명|학교)$') {
    return (($OriginalTitle -replace '\s+$', '') -replace '_?\]$', '_]')
  }
  $stem = [IO.Path]::GetFileNameWithoutExtension($FileName)
  if ($stem -match '^(\d{4}년)\s*_?[^_]*_(.+?)_학교별자료') {
    return "$($Matches[1])_ [$($Matches[2])_]"
  }
  return $stem
}

function Convert-FlatHeader([string]$Header) {
  $parts = @($Header -split ' / ' | ForEach-Object { ($_ -replace '[\r\n]+', ' ' -replace '\s+', '').Trim('_') } | Where-Object { $_ })
  if ($parts.Count -gt 1 -and $parts[0] -match '및|구분$|^연구비지원$') { $parts = $parts[1..($parts.Count - 1)] }
  if ($parts.Count -and $parts[0] -eq '전임교원1인당연구비') { $parts[0] = '1인당연구비' }
  $result = (($parts -join '_') -replace '_+', '_').Trim('_')
  if ($result -eq '학교명') { return '학교' }
  if ($result -eq '상태') { return '상태정보' }
  return $result
}

function Get-CleanSheetName([string]$Title, [string]$Fallback) {
  $name = $Title
  if ($name -match '\[([^\]]+)\]') { $name = $Matches[1] }
  $name = $name -replace '^\s*\d+[-가-힣0-9\.]*\s*\.\s*', ''
  $name = $name -replace '[^0-9A-Za-z가-힣]', ''
  if (-not $name) { $name = ($Fallback -replace '[^0-9A-Za-z가-힣]', '') }
  $suffix = '_정제'
  $maxBase = 31 - $suffix.Length
  if ($name.Length -gt $maxBase) { $name = $name.Substring(0, $maxBase) }
  return "$name$suffix"
}

function Is-Number($Value) {
  return $null -ne $Value -and $Value -ne '' -and ($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or $Value -is [single] -or $Value -is [double] -or $Value -is [decimal])
}

function Convert-GraduationYear($Value) {
  if ($null -eq $Value -or "$Value" -eq '') { return '' }
  $digits = ([string]$Value -replace '[^0-9]', '')
  if ($digits.Length -eq 6 -and $digits -match '^(19|20)\d{4}$') {
    return $digits.Substring(0, 4) + '.' + $digits.Substring(4, 2)
  }
  return [string]$Value
}

function Find-WeightColumn($Headers, [int]$TargetColumn, $Rows) {
  $preferred = @()
  $secondary = @()
  for ($column = 1; $column -lt $TargetColumn; $column++) {
    $header = [string]$Headers[$column]
    $leaf = ($header -split ' / ')[-1]
    $hasValues = $false
    foreach ($row in $Rows) { if (Is-Number $row[$column]) { $hasValues = $true; break } }
    if (-not $hasValues -or $leaf -match '비율|평균|비중|1인당') { continue }
    if ($header -match '총|전체|대상|정원|모수') { $preferred += $column }
    elseif ($leaf -match '학생수|인원|교원수|건수|개수|수$') { $secondary += $column }
  }
  if ($preferred.Count) { return $preferred[-1] }
  if ($secondary.Count) { return $secondary[0] }
  return 0
}

function Get-SummedValue($Rows, [int]$Column) {
  $sum = 0.0
  foreach ($row in $Rows) { if (Is-Number $row[$Column]) { $sum += [double]$row[$Column] } }
  return $sum
}

function Find-FlatHeaderColumn($Headers, [int]$ColumnCount, [string]$Pattern) {
  for ($column = 1; $column -le $ColumnCount; $column++) {
    if ((Convert-FlatHeader ([string]$Headers[$column])) -match $Pattern) { return $column }
  }
  return 0
}

function Aggregate-Rows($Rows, $Headers, [int]$ColumnCount, [int]$SchoolColumn, [string]$ItemKind) {
  $result = New-Object object[] $ColumnCount
  $first = $Rows[0]
  for ($column = 1; $column -le $ColumnCount; $column++) {
    if ($column -eq $SchoolColumn) { $result[$column - 1] = $first[0]; continue }
    $header = [string]$Headers[$column]
    $leaf = ($header -split ' / ')[-1]
    if ($header -match '기준연도|^연도$') { $result[$column - 1] = [string]$first[$column]; continue }
    if ($header -match '졸업연도') { $result[$column - 1] = Convert-GraduationYear $first[$column]; continue }
    if ($header -match '학교종류|설립구분|상태') { $result[$column - 1] = $first[$column]; continue }
    $numeric = @($Rows | ForEach-Object { $_[$column] } | Where-Object { Is-Number $_ })
    if (-not $numeric.Count) {
      $texts = @($Rows | ForEach-Object { [string]$_[$column] } | Where-Object { $_ -ne '' } | Select-Object -Unique)
      $result[$column - 1] = if ($texts.Count) { $texts[0] } else { '' }
      continue
    }
    if (($ItemKind -match '졸업생[\s_]*의?[\s_]*취업[\s_]*현황' -and $column -ge 39) -or $header -match '유지취업률') {
      $result[$column - 1] = [math]::Round((($numeric | Measure-Object -Sum).Sum) / $Rows.Count, 1)
    } elseif ($leaf -match '비율|비중|율\b|퍼센트|%') {
      $numeratorColumn = 0
      if ($column -gt 1 -and [string]$Headers[$column - 1] -match '학생수|인원|건수|수$') { $numeratorColumn = $column - 1 }
      $denominatorColumn = Find-WeightColumn $Headers $column $Rows
      if ($numeratorColumn -and $denominatorColumn -and $numeratorColumn -ne $denominatorColumn) {
        $numerator = 0.0; $denominator = 0.0
        foreach ($row in $Rows) {
          if (Is-Number $row[$numeratorColumn]) { $numerator += [double]$row[$numeratorColumn] }
          if (Is-Number $row[$denominatorColumn]) { $denominator += [double]$row[$denominatorColumn] }
        }
        $scale = if (($numeric | Measure-Object -Average).Average -gt 1) { 100.0 } else { 1.0 }
        $result[$column - 1] = if ($denominator) { [math]::Round(($numerator / $denominator) * $scale, 4) } else { 0 }
      } else {
        $weightColumn = Find-WeightColumn $Headers $column $Rows
        $weighted = 0.0; $weights = 0.0
        foreach ($row in $Rows) { if (Is-Number $row[$column]) { $weight = if ($weightColumn -and (Is-Number $row[$weightColumn])) { [double]$row[$weightColumn] } else { 1.0 }; $weighted += [double]$row[$column] * $weight; $weights += $weight } }
        $result[$column - 1] = if ($weights) { [math]::Round($weighted / $weights, 4) } else { 0 }
      }
    } elseif ($header -match '1인당') {
      $gender = if ($header -match '남') { '남' } elseif ($header -match '여') { '여' } else { '' }
      $scope = if ($header -match '교내') { '교내' } elseif ($header -match '교외') { '교외' } else { '' }
      $numeratorColumns = @(); $denominatorColumn = 0
      for ($candidate = 1; $candidate -lt $column; $candidate++) {
        $candidateHeader = [string]$Headers[$candidate]
        $candidateFlat = Convert-FlatHeader $candidateHeader
        if ($scope -eq '교내' -and $candidateFlat -eq "교내_연구비_$gender") { $numeratorColumns = @($candidate) }
        if ($scope -eq '교외' -and $candidateFlat -match "^교외_.+_연구비_$gender$") { $numeratorColumns += $candidate }
        if ($candidateFlat -eq "전임교원_$gender") { $denominatorColumn = $candidate }
      }
      if ($numeratorColumns.Count -and $denominatorColumn) {
        $numerator = 0.0; $denominator = 0.0
        foreach ($row in $Rows) {
          foreach ($numeratorColumn in $numeratorColumns) { if (Is-Number $row[$numeratorColumn]) { $numerator += [double]$row[$numeratorColumn] } }
          if (Is-Number $row[$denominatorColumn]) { $denominator += [double]$row[$denominatorColumn] }
        }
        $result[$column - 1] = if ($denominator) { [math]::Round($numerator / $denominator, 4) } else { 0 }
      } else {
        $result[$column - 1] = [math]::Round((($numeric | Measure-Object -Average).Average), 1)
      }
    } elseif ($leaf -match '평균|평점') {
      $weightColumn = Find-WeightColumn $Headers $column $Rows
      $weighted = 0.0; $weights = 0.0
      foreach ($row in $Rows) { if (Is-Number $row[$column]) { $weight = if ($weightColumn -and (Is-Number $row[$weightColumn])) { [double]$row[$weightColumn] } else { 1.0 }; $weighted += [double]$row[$column] * $weight; $weights += $weight } }
      $result[$column - 1] = if ($weights) { [math]::Round($weighted / $weights, 4) } else { 0 }
    } else {
      $result[$column - 1] = [double](($numeric | Measure-Object -Sum).Sum)
    }
  }

  if ($ItemKind -match '외국학생[\s_]*현황') {
    $degree = Find-FlatHeaderColumn $Headers $ColumnCount '^학위과정.*_소계\(A\)$'
    $training = Find-FlatHeaderColumn $Headers $ColumnCount '^연수과정_소계\(C\)$'
    $language = Find-FlatHeaderColumn $Headers $ColumnCount '^언어능력_계\(E\)$'
    $languageRate = Find-FlatHeaderColumn $Headers $ColumnCount '^언어능력충족학생비율'
    $degreeDorm = Find-FlatHeaderColumn $Headers $ColumnCount '^기숙사.*_학위과정_계\(F\)$'
    $trainingDorm = Find-FlatHeaderColumn $Headers $ColumnCount '^기숙사.*_비학위과정_계\(G\)$'
    $trainingAccepted = Find-FlatHeaderColumn $Headers $ColumnCount '^기숙사.*_비학위과정_수용$'
    $trainingNotAccepted = Find-FlatHeaderColumn $Headers $ColumnCount '^기숙사.*_비학위과정_미수용$'
    if ($degree -and $language -and $languageRate) {
      $denominator = Get-SummedValue $Rows $degree
      $result[$languageRate - 1] = if ($denominator) { [math]::Round((Get-SummedValue $Rows $language) / $denominator * 100, 1) } else { 0 }
    }
    if ($degree -and $degreeDorm) { $result[$degreeDorm - 1] = Get-SummedValue $Rows $degree }
    if ($trainingDorm -and $trainingAccepted -and $trainingNotAccepted) {
      $result[$trainingDorm - 1] = (Get-SummedValue $Rows $trainingAccepted) + (Get-SummedValue $Rows $trainingNotAccepted)
    }
  }

  if ($ItemKind -match '전임교원[\s_]*의?[\s_]*연구[\s_]*실적') {
    for ($column = 1; $column -le $ColumnCount; $column++) {
      $flat = Convert-FlatHeader ([string]$Headers[$column])
      $metric = ''; $gender = ''
      if ($flat -match '^전임교원1인당논문실적_(.+)_(계|남|여)$') { $metric = $Matches[1]; $gender = $Matches[2] }
      elseif ($flat -match '^전임교원1인당저.*역서실적_(계|남|여)$') { $metric = '저역서'; $gender = $Matches[1] }
      else { continue }
      $numeratorPattern = switch -Regex ($metric) {
        '국내기준' { '^논문실적_국내_소계_' + $gender + '$' }
        '국제기준' { '^논문실적_국제_소계_' + $gender + '$' }
        '등재지' { '^논문실적_국내_연구재단등재지.*_' + $gender + '$' }
        'SCI' { '^논문실적_국제_SCI.*_' + $gender + '$' }
        default { if ($gender -eq '계') { '^저.*역서실적_계$' } else { '^저.*역서실적_계_' + $gender + '$' } }
      }
      $numeratorColumn = Find-FlatHeaderColumn $Headers $ColumnCount $numeratorPattern
      $denominatorColumn = Find-FlatHeaderColumn $Headers $ColumnCount ('^전임교원_' + $gender + '$')
      if ($numeratorColumn -and $denominatorColumn) {
        $denominator = Get-SummedValue $Rows $denominatorColumn
        $result[$column - 1] = if ($denominator) { [math]::Round((Get-SummedValue $Rows $numeratorColumn) / $denominator, 4, [MidpointRounding]::AwayFromZero) } else { 0 }
      }
    }
  }

  if ($ItemKind -match '학생[\s_]*1인당[\s_]*교육비') {
    $cost = Find-FlatHeaderColumn $Headers $ColumnCount '^총교육비\(E=A\+B\+C\+D\)$'
    $students = Find-FlatHeaderColumn $Headers $ColumnCount '^재학생수\(F\)$'
    $perStudent = Find-FlatHeaderColumn $Headers $ColumnCount '^학생1인당교육비'
    if ($cost -and $students -and $perStudent) {
      $denominator = Get-SummedValue $Rows $students
      $result[$perStudent - 1] = if ($denominator) { [math]::Round((Get-SummedValue $Rows $cost) / $denominator, 1) } else { 0 }
    }
  }
  return ,$result
}

$source = [IO.Path]::GetFullPath($SourceFolder)
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw '원본 폴더를 찾을 수 없습니다.' }
$output = Join-Path $source '정제'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$files = @(Get-ChildItem -LiteralPath $source -File | Where-Object { $_.Extension -in @('.xlsx', '.xls') -and -not $_.Name.StartsWith('~$') -and (-not $FileName -or $_.Name -eq $FileName) })
if ($FileName -and -not $files.Count) { throw "선택한 원본 파일을 찾을 수 없습니다: $FileName" }
if (-not $files.Count) { throw '원본 폴더에 XLSX 또는 XLS 파일이 없습니다.' }

$excel = $null
$results = New-Object System.Collections.Generic.List[object]
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.AskToUpdateLinks = $false
  foreach ($file in $files) {
    $book = $null
    try {
      $book = $excel.Workbooks.Open($file.FullName, 0, $false)
      $beforeTotal = 0; $afterTotal = 0; $mergedTotal = 0
      foreach ($sheet in @($book.Worksheets)) {
        $used = $sheet.UsedRange
        if ($used.Rows.Count -le 3) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($used); continue }
        $originalTitle = [string]$sheet.Cells.Item(1, 1).Text
        $unitNote = ''
        for ($noteRow = 1; $noteRow -le 3; $noteRow++) {
          for ($noteColumn = 1; $noteColumn -le [math]::Min(5, $used.Columns.Count); $noteColumn++) {
            $noteText = [string]$sheet.Cells.Item($noteRow, $noteColumn).Text
            if ($noteText -match '단위') { $unitNote = $noteText; break }
          }
          if ($unitNote) { break }
        }
        $columnCount = $used.Columns.Count
        $lastRow = $used.Rows.Count
        $layout = Find-SheetLayout $sheet $lastRow $columnCount
        if (-not $layout) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($used); continue }
        $headers = @{}
        $schoolColumn = [int]$layout.SchoolColumn
        $schoolTypeColumn = 0; $statusColumn = 0
        for ($column = 1; $column -le $columnCount; $column++) {
          $headers[$column] = Get-HeaderText $sheet $column $layout.HeaderStart $layout.HeaderEnd
          if (-not $schoolTypeColumn -and [string]$headers[$column] -match '학교종류') { $schoolTypeColumn = $column }
          if (-not $statusColumn -and [string]$headers[$column] -match '상태') { $statusColumn = $column }
        }
        $dataRange = $sheet.Range($sheet.Cells.Item($layout.DataStart, 1), $sheet.Cells.Item($lastRow, $columnCount))
        if ($dataRange.MergeCells) { $dataRange.UnMerge() }
        $values = $dataRange.Value2
        $rowCount = $lastRow - $layout.DataStart + 1
        $beforeTotal += $rowCount
        $rows = New-Object System.Collections.Generic.List[object]
        $lastSchool = ''
        $carry = @{}
        for ($r = 1; $r -le $rowCount; $r++) {
          $row = @{}
          $hasAnyValue = $false
          $rowNumericCount = 0
          for ($c = 1; $c -le $columnCount; $c++) {
            $value = $values[$r, $c]
            if ($null -ne $value -and "$value" -ne '') { $hasAnyValue = $true }
            if (Is-Number $value) { $rowNumericCount++ }
            if ([string]$headers[$c] -match '기준연도|^연도$|학교종류|설립구분|지역|상태' -and ($null -eq $value -or "$value" -eq '')) { $value = $carry[$c] }
            elseif ($null -ne $value -and "$value" -ne '') { $carry[$c] = $value }
            $row[$c] = $value
          }
          if (-not $hasAnyValue -or $rowNumericCount -eq 0) { continue }
          $school = [string]$row[$schoolColumn]
          if ($file.Name -match '연구비[\s_]*수혜[\s_]*실적' -and -not $school) { continue }
          if ($school) { $lastSchool = $school } else { $school = $lastSchool }
          if (-not $school) { continue }
          $schoolType = if ($schoolTypeColumn) { [string]$row[$schoolTypeColumn] } else { '' }
          $status = if ($statusColumn) { [string]$row[$statusColumn] } else { '' }
          $allowedSchoolTypes = @('대학교', '교육대학', '산업대학', '기술대학')
          if ($schoolTypeColumn -and $schoolType -notin $allowedSchoolTypes) { continue }
          if ($statusColumn -and $status -and $status -ne '기존') { continue }
          if ($school -eq '한국전통문화대학교') { continue }
          $normalized = Normalize-SchoolName $school
          $row[$schoolColumn] = $normalized
          $row[0] = $normalized
          $rows.Add($row)
        }
        $groupMap = [ordered]@{}
        foreach ($row in $rows) {
          $dimensions = @($row[0])
          for ($c = 1; $c -le $columnCount; $c++) {
            $header = [string]$headers[$c]
            $value = $row[$c]
            if ($c -ne $schoolColumn -and $header -match '기준연도|^연도$|학교종류|설립구분') { $dimensions += [string]$value }
          }
          $groupKey = $dimensions -join [char]31
          if (-not $groupMap.Contains($groupKey)) { $groupMap[$groupKey] = New-Object System.Collections.Generic.List[object] }
          $groupMap[$groupKey].Add($row)
        }
        $outputRows = New-Object System.Collections.Generic.List[object]
        $mergedSchools = New-Object 'System.Collections.Generic.HashSet[string]'
        foreach ($group in $groupMap.Values) {
          $groupRows = $group.ToArray()
          $outputRows.Add((Aggregate-Rows $groupRows $headers $columnCount $schoolColumn $file.Name))
          if ($group.Count -gt 1) { $mergedTotal += $group.Count - 1; [void]$mergedSchools.Add([string]$groupRows[0][0]) }
        }

        if ($file.Name -match '졸업생[\s_]*의?[\s_]*취업[\s_]*현황' -and $columnCount -eq 50) {
          $employmentRows = New-Object System.Collections.Generic.List[object]
          foreach ($outputRow in $outputRows) {
            $shifted = New-Object object[] $columnCount
            for ($c = 0; $c -lt 6; $c++) { $shifted[$c] = $outputRow[$c] }
            $male = if (Is-Number $outputRow[6]) { [double]$outputRow[6] } else { 0 }
            $female = if (Is-Number $outputRow[7]) { [double]$outputRow[7] } else { 0 }
            $shifted[6] = $male + $female
            for ($c = 7; $c -lt $columnCount; $c++) { $shifted[$c] = $outputRow[$c - 1] }
            $excluded = 0.0
            for ($c = 21; $c -le 29; $c++) { if (Is-Number $shifted[$c]) { $excluded += [double]$shifted[$c] } }
            $employmentBase = [double]$shifted[6] - $excluded
            if (-not $employmentBase) { $shifted[34] = $null }
            elseif ($mergedSchools.Contains([string]$shifted[$schoolColumn - 1])) {
              $employed = 0.0
              for ($c = 9; $c -le 20; $c++) { if (Is-Number $shifted[$c]) { $employed += [double]$shifted[$c] } }
              $employmentRate = ([decimal]$employed / [decimal]$employmentBase) * [decimal]100
              $shifted[34] = [math]::Round($employmentRate, 1)
            }
            $shifted[48] = $null
            $shifted[49] = $null
            $employmentRows.Add($shifted)
          }
          $outputRows = $employmentRows
        }
        for ($pair = 0; $pair -lt $exceptions.Count; $pair += 2) {
          $baseIndex = -1; $branchIndex = -1
          for ($index = 0; $index -lt $outputRows.Count; $index++) {
            $outputSchool = [string]$outputRows[$index][$schoolColumn - 1]
            if ($outputSchool -eq $exceptions[$pair]) { $baseIndex = $index }
            if ($outputSchool -eq $exceptions[$pair + 1]) { $branchIndex = $index }
          }
          if ($branchIndex -ge 0 -and $baseIndex -ge 0 -and $branchIndex -lt $baseIndex) {
            $branchRow = $outputRows[$branchIndex]; $outputRows.RemoveAt($branchIndex); $baseIndex--
            $outputRows.Insert($baseIndex + 1, $branchRow)
          }
        }
        $afterTotal += $outputRows.Count
        $wholeUsed = $sheet.UsedRange
        if ($wholeUsed.MergeCells) { $wholeUsed.UnMerge() }
        $wholeUsed.Clear() | Out-Null
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wholeUsed)
        $cleanTitle = Get-OutputTitle $originalTitle $file.Name
        if ($file.Name -match '연구비') { $unitNote = '(단위 : 천원, 1인당 연구비: 천원/명)' }
        $sheet.Cells.Item(1, 1).Value2 = "$cleanTitle 정제 데이터"
        $sheet.Cells.Item(2, 1).Value2 = $unitNote
        $flatHeaders = @{}
        for ($c = 1; $c -le $columnCount; $c++) { $flatHeaders[$c] = Convert-FlatHeader ([string]$headers[$c]); $sheet.Cells.Item(3, $c).Value2 = [string]$flatHeaders[$c] }
        $headerRange = $sheet.Range($sheet.Cells.Item(3, 1), $sheet.Cells.Item(3, $columnCount))
        if ($outputRows.Count) {
          $tempTsv = Join-Path $env:TEMP ("academy-clean-" + [guid]::NewGuid().ToString('N') + '.tsv')
          $builder = New-Object Text.StringBuilder
          foreach ($outputRow in $outputRows) {
            $fields = for ($c = 0; $c -lt $columnCount; $c++) {
              $value = $outputRow[$c]
              if (Is-Number $value) { ([double]$value).ToString([Globalization.CultureInfo]::InvariantCulture) }
              else { '"' + (([string]$value -replace '[\r\n\t]+', ' ' -replace '"', '""')) + '"' }
            }
            [void]$builder.AppendLine(($fields -join "`t"))
          }
          [IO.File]::WriteAllText($tempTsv, $builder.ToString(), (New-Object Text.UTF8Encoding($true)))
          $destinationCell = $sheet.Cells.Item(4, 1)
          $query = $sheet.QueryTables.Add("TEXT;$tempTsv", $destinationCell)
          $query.TextFilePlatform = 65001
          $query.TextFileParseType = 1
          $query.TextFileTabDelimiter = $true
          $query.TextFileTextQualifier = 1
          $columnTypes = New-Object object[] $columnCount
          for ($typeColumn = 1; $typeColumn -le $columnCount; $typeColumn++) {
            $columnTypes[$typeColumn - 1] = if ([string]$flatHeaders[$typeColumn] -match '기준연도|졸업연도') { 2 } else { 1 }
          }
          $query.TextFileColumnDataTypes = $columnTypes
          $query.AdjustColumnWidth = $false
          $query.RefreshStyle = 0
          [void]$query.Refresh($false)
          $query.Delete()
          Remove-Item -LiteralPath $tempTsv -Force -ErrorAction SilentlyContinue
          [void][Runtime.InteropServices.Marshal]::ReleaseComObject($query)
          [void][Runtime.InteropServices.Marshal]::ReleaseComObject($destinationCell)
        }
        $firstUnusedRow = 4 + $outputRows.Count
        $finalLastRow = 3 + $outputRows.Count
        $bodyRange = $sheet.Range($sheet.Cells.Item(4, 1), $sheet.Cells.Item($finalLastRow, $columnCount))
        $allRange = $sheet.Range($sheet.Cells.Item(3, 1), $sheet.Cells.Item($finalLastRow, $columnCount))
        $sheet.Range($sheet.Cells.Item(1, 1), $sheet.Cells.Item($finalLastRow, $columnCount)).Font.Name = '맑은 고딕'
        $sheet.Cells.Item(1, 1).Font.Bold = $true
        $sheet.Cells.Item(1, 1).Font.Size = 12
        $sheet.Cells.Item(2, 1).Font.Size = 9
        $sheet.Cells.Item(2, 1).Font.Color = 0x666666
        $headerRange.Interior.Color = 0x794E1F
        $headerRange.Font.Color = 0xFFFFFF
        $headerRange.Font.Bold = $true
        $headerRange.Font.Size = 9
        $headerRange.HorizontalAlignment = -4108
        $headerRange.VerticalAlignment = -4108
        $headerRange.WrapText = $true
        $headerRange.RowHeight = 34
        $allRange.Borders.LineStyle = 1
        $allRange.Borders.Color = 0xE7C6B4
        $allRange.Borders.Weight = 2
        $bodyRange.Font.Size = 9
        $bodyRange.VerticalAlignment = -4108
        for ($c = 1; $c -le $columnCount; $c++) {
          $flatHeader = [string]$flatHeaders[$c]
          $columnRange = $sheet.Range($sheet.Cells.Item(4, $c), $sheet.Cells.Item($finalLastRow, $c))
          if ($flatHeader -match '졸업연도') { $columnRange.NumberFormat = '@'; $columnRange.HorizontalAlignment = -4108 }
          elseif ($c -le 6) { $columnRange.HorizontalAlignment = -4108 }
          elseif ($flatHeader -match '비율|평균|평점|1인당') { $columnRange.NumberFormat = '#,##0.0' }
          else { $columnRange.NumberFormat = '#,##0' }
          [void][Runtime.InteropServices.Marshal]::ReleaseComObject($columnRange)
        }
        $sheet.Columns.Item(1).ColumnWidth = 10
        $sheet.Columns.Item(2).ColumnWidth = 11
        $sheet.Columns.Item(3).ColumnWidth = 10
        $sheet.Columns.Item(4).ColumnWidth = 9
        $sheet.Columns.Item(5).ColumnWidth = 10
        $sheet.Columns.Item(6).ColumnWidth = 24
        if ($columnCount -gt 6) { $sheet.Range($sheet.Columns.Item(7), $sheet.Columns.Item($columnCount)).ColumnWidth = 14 }
        $allRange.AutoFilter() | Out-Null
        $sheet.Application.ActiveWindow.SplitRow = 3
        $sheet.Application.ActiveWindow.FreezePanes = $true
        $sheet.Name = Get-CleanSheetName $originalTitle $sheet.Name
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($bodyRange)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($allRange)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($headerRange)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($dataRange)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($used)
      }
      $baseName = [IO.Path]::GetFileNameWithoutExtension($file.Name)
      if ($baseName -notmatch '_정제$') { $baseName += '_정제' }
      $destination = Join-Path $output ($baseName + '.xlsx')
      $book.SaveAs($destination, 51)
      $book.Close($false)
      $results.Add([pscustomobject]@{ file = $file.Name; status = 'success'; before = $beforeTotal; after = $afterTotal; merged = $mergedTotal })
    } catch {
      if ($book) { $book.Close($false) }
      $results.Add([pscustomobject]@{ file = $file.Name; status = 'error'; error = $_.Exception.Message })
    } finally {
      if ($book) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($book) }
    }
  }
} finally {
  if ($excel) { $excel.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel) }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$resultArray = $results.ToArray()
$successCount = ($resultArray | Where-Object status -eq 'success' | Measure-Object).Count
$failedCount = ($resultArray | Where-Object status -eq 'error' | Measure-Object).Count
[pscustomobject]@{
  source = $source
  output = $output
  total = $files.Count
  success = $successCount
  failed = $failedCount
  files = $resultArray
} | ConvertTo-Json -Depth 6 -Compress
