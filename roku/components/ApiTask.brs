sub init()
  m.top.functionName = "doRequest"
end sub

sub doRequest()
  res = { ok: false, status: 0, data: invalid, error: "", tag: m.top.tag }
  xfer = CreateObject("roUrlTransfer")
  port = CreateObject("roMessagePort")
  xfer.SetMessagePort(port)
  xfer.SetUrl(m.top.url)
  xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  xfer.InitClientCertificates()
  xfer.AddHeader("Accept", "application/json")
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
      parsed = ParseJson(msg.GetString())
      if parsed <> invalid then res.data = parsed
      res.ok = (res.status >= 200 and res.status < 300 and parsed <> invalid)
      if not res.ok and res.error = "" then res.error = "http " + res.status.toStr()
    end if
  else
    res.error = "request"
  end if
  m.top.result = res
end sub
