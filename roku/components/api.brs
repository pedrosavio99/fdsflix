' Auxiliares compartilhados (incluídos por <script> nos componentes que falam com a API).

' Faz GET na API; `callback` é o NOME de uma função do componente que recebe o evento (event.getData() = resultado).
sub apiGet(path as string, callback as string, tag = "" as string)
  if m.apiTasks = invalid then m.apiTasks = {}
  if m.apiSeq = invalid then m.apiSeq = 0
  m.apiSeq = m.apiSeq + 1
  task = CreateObject("roSGNode", "ApiTask")
  task.url = m.global.apiBase + path
  task.apiKey = m.global.apiKey
  task.tag = tag
  key = m.apiSeq.toStr()
  m.apiTasks[key] = task
  task.observeField("result", callback)
  task.control = "RUN"
end sub

' Percent-encoding em UTF-8, feito à mão: roUrlTransfer não pode ser criado fora de uma Task.
function urlEnc(value as string) as string
  out = ""
  hex = "0123456789ABCDEF"
  for i = 1 to Len(value)
    ch = Mid(value, i, 1)
    cp = Asc(ch)
    if (cp >= 48 and cp <= 57) or (cp >= 65 and cp <= 90) or (cp >= 97 and cp <= 122) or cp = 45 or cp = 46 or cp = 95 or cp = 126
      out = out + ch
    else
      bytes = []
      if cp < 128
        bytes.push(cp)
      else if cp < 2048
        bytes.push(192 + Int(cp / 64))
        bytes.push(128 + (cp mod 64))
      else if cp < 65536
        bytes.push(224 + Int(cp / 4096))
        bytes.push(128 + (Int(cp / 64) mod 64))
        bytes.push(128 + (cp mod 64))
      else
        bytes.push(240 + Int(cp / 262144))
        bytes.push(128 + (Int(cp / 4096) mod 64))
        bytes.push(128 + (Int(cp / 64) mod 64))
        bytes.push(128 + (cp mod 64))
      end if
      for each b in bytes
        out = out + "%" + Mid(hex, Int(b / 16) + 1, 1) + Mid(hex, (b mod 16) + 1, 1)
      end for
    end if
  end for
  return out
end function

function joinList(list as object, sep as string) as string
  out = ""
  for i = 0 to list.count() - 1
    if i > 0 then out = out + sep
    out = out + list[i]
  end for
  return out
end function

function posterUrl(path as dynamic, size as string) as string
  if type(path) = "roString" or type(path) = "String"
    if path <> "" then return "https://image.tmdb.org/t/p/" + size + path
  end if
  return ""
end function

' URL de legenda em .srt (o Roku lê SRT de arquivo externo; o servidor converte de WebVTT).
function srtUrl(u as string) as string
  p = Instr(1, u, "/api/subtitle?")
  if p > 0 then return Left(u, p - 1) + "/api/subtitle.srt?" + Mid(u, p + Len("/api/subtitle?"))
  return u
end function

' Texto de falha: só aparece com debug=true no config.json (zip baixado pelo admin). O público nunca vê detalhe técnico.
function failText(base as string, res as dynamic) as string
  if m.global.debug <> true then return base
  if res = invalid then return base + "  [sem resposta]"
  info = "  [" + res.error
  if res.status <> invalid then info = info + " · status " + res.status.toStr()
  if res.url <> invalid then info = info + " · " + res.url
  return base + info + "]"
end function

function makeFont(uri as string, size as integer) as object
  f = CreateObject("roSGNode", "Font")
  f.uri = uri
  f.size = size
  return f
end function

' "2024  ·  ★ 7.8  ·  Ação, Aventura"
function metaLine(year as dynamic, rating as dynamic, genres as dynamic) as string
  parts = []
  if year <> invalid and year <> "" then parts.push(year)
  if rating <> invalid
    t = type(rating)
    if (t = "roFloat" or t = "Float" or t = "roDouble" or t = "Double" or t = "roInt" or t = "Integer") and rating > 0
      parts.push("★ " + Str(rating).trim())
    end if
  end if
  if genres <> invalid and genres <> "" then parts.push(genres)
  return joinList(parts, "   ·   ")
end function

' Item de lista (id = "movie:603" | "tv:1396" | "live:globo").
'   poster = miniatura da fileira, big = pôster da tela de detalhes, backdrop = fundo do destaque
function makeItem(kind as string, id as dynamic, title as string, poster as string, big as string, backdrop as string, year as string, overview as string, rating as dynamic, genres as string) as object
  item = CreateObject("roSGNode", "ContentNode")
  item.id = kind + ":" + id.toStr()
  item.title = title
  item.HDPosterUrl = poster
  item.FHDPosterUrl = big
  item.HDBackgroundImageUrl = backdrop
  item.ReleaseDate = year
  item.Description = overview
  item.ShortDescriptionLine2 = genres
  if rating <> invalid
    t = type(rating)
    if t = "roFloat" or t = "Float" or t = "roInt" or t = "Integer" or t = "roDouble" or t = "Double"
      item.StarRating = Int(rating * 10)
    end if
  end if
  return item
end function

function genreText(list as dynamic) as string
  if list = invalid then return ""
  return joinList(list, ", ")
end function
