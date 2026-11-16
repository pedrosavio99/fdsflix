sub onContent()
  c = m.top.itemContent
  if c = invalid then return
  m.top.findNode("poster").uri = c.HDPosterUrl
  m.top.findNode("name").text = c.title
end sub
