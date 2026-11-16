' Baixa a legenda (.srt) e já devolve as falas prontas. Tradução automática pode levar vários segundos no servidor.
sub init()
  m.top.functionName = "doRequest"
end sub

sub doRequest()
  res = { ok: false, status: 0, tag: m.top.tag, cues: [], count: 0, error: "" }
  xfer = CreateObject("roUrlTransfer")
  port = CreateObject("roMessagePort")
  xfer.SetMessagePort(port)
  xfer.SetUrl(m.top.url)
  xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  xfer.InitClientCertificates()
  if m.top.apiKey <> "" then xfer.AddHeader("x-api-key", m.top.apiKey)
  xfer.EnableEncodings(true)
  xfer.RetainBodyOnError(true)
  if xfer.AsyncGetToString()
    msg = wait(m.top.timeoutMs, port)
    if msg = invalid
      xfer.AsyncCancel()
      res.error = "timeout"
    else if type(msg) = "roUrlEvent"
      res.status = msg.GetResponseCode()
      if res.status >= 200 and res.status < 300
        cues = parseSrt(msg.GetString())
        res.cues = cues
        res.count = cues.count()
        res.ok = (res.count > 0)
        if not res.ok then res.error = "sem falas"
      else
        res.error = "http " + res.status.toStr()
      end if
    end if
  else
    res.error = "request"
  end if
  m.top.result = res
end sub
