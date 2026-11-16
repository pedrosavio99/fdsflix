' Leitor de legenda (SRT e WebVTT) -> lista de falas { s: início (s), e: fim (s), t: texto }.
' Roda dentro de uma Task (SubTask), nunca na thread da tela.

' "00:01:02,500" / "00:01:02.500" / "01:02.500" (+ configurações do VTT depois de um espaço) -> segundos; -1 se inválido
function srtTime(raw as string) as float
  t = raw.trim()
  sp = Instr(1, t, " ")
  if sp > 0 then t = Left(t, sp - 1)
  t = t.replace(",", ".")
  parts = t.split(":")
  n = parts.count()
  if n = 3
    return parts[0].toInt() * 3600 + parts[1].toInt() * 60 + parts[2].toFloat()
  else if n = 2
    return parts[0].toInt() * 60 + parts[1].toFloat()
  end if
  return -1
end function

function srtClean(body as string, rx as object) as string
  if Instr(1, body, "<") > 0 or Instr(1, body, "{") > 0 then body = rx.replaceAll(body, "")
  if Instr(1, body, "&") > 0
    body = body.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", Chr(34)).replace("&#39;", "'").replace("&nbsp;", " ")
  end if
  return body.trim()
end function

function parseSrt(text as string) as object
  cues = []
  rx = CreateObject("roRegex", "<[^>]*>|\{[^}]*\}", "")
  lines = text.replace(Chr(13), "").split(Chr(10))
  n = lines.count()
  i = 0
  sorted = true
  lastStart = -1
  while i < n
    line = lines[i]
    p = Instr(1, line, "-->")
    if p > 0
      s = srtTime(Left(line, p - 1))
      e = srtTime(Mid(line, p + 3))
      i = i + 1
      body = ""
      while i < n and Len(lines[i].trim()) > 0
        if body <> "" then body = body + Chr(10)
        body = body + lines[i]
        i = i + 1
      end while
      body = srtClean(body, rx)
      if s >= 0 and e > s and body <> ""
        if s < lastStart then sorted = false
        lastStart = s
        cues.push({ s: s, e: e, t: body })
      end if
    else
      i = i + 1
    end if
  end while
  if not sorted then cues.sortBy("s")
  return cues
end function

' Índice da fala que cobre a posição (segundos), ou -1. Busca binária (as falas estão em ordem).
function findCue(cues as object, secs as float) as integer
  lo = 0
  hi = cues.count() - 1
  found = -1
  while lo <= hi
    middle = Int((lo + hi) / 2)
    if cues[middle].s <= secs
      found = middle
      lo = middle + 1
    else
      hi = middle - 1
    end if
  end while
  if found >= 0 and cues[found].e > secs then return found
  return -1
end function
