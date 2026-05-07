const express = require('express')
const QRCode = require('qrcode')
const { nanoid } = require('nanoid')
const cors = require('cors')
const multer = require('multer')
const path = require('path')
const fs = require('fs')

const app = express()
const PORT = process.env.PORT || 3000
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`
const UPLOAD_DIR = path.join(__dirname, '../uploads')
const DATA_FILE = path.join(__dirname, '../data/links.json')

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
const dataDir = path.dirname(DATA_FILE)
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'))
    return {}
  } catch { return {} }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

let urlStore = loadData()

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, '../public')))
app.use('/uploads', express.static(UPLOAD_DIR))

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${nanoid(12)}${ext}`)
  }
})
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml']
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('仅支持图片文件'))
  }
})

function generateShortCode() { return nanoid(6) }

app.get('/api/list', (req, res) => {
  const list = Object.entries(urlStore).map(([code, record]) => ({ code, ...record }))
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  res.json(list)
})

app.post('/api/upload-qrcode', upload.single('qrcode'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传二维码图片' })
  const code = generateShortCode()
  urlStore[code] = {
    type: 'qrcode_image',
    imagePath: `/uploads/${req.file.filename}`,
    originalName: req.file.originalname,
    shortUrl: `${BASE_URL}/${code}`,
    createdAt: new Date().toISOString(),
    clickCount: 0
  }
  saveData(urlStore)
  res.json({ code, ...urlStore[code], imageUrl: `${BASE_URL}${urlStore[code].imagePath}`, viewUrl: `/${code}` })
})

app.post('/api/shorten', async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL is required' })
  try { new URL(url) } catch { return res.status(400).json({ error: 'Invalid URL format' }) }
  const code = generateShortCode()
  urlStore[code] = {
    type: 'redirect',
    originalUrl: url,
    shortUrl: `${BASE_URL}/${code}`,
    createdAt: new Date().toISOString(),
    clickCount: 0
  }
  saveData(urlStore)
  res.json({ code, ...urlStore[code], qrcodeUrl: `/api/qrcode/${code}` })
})

app.get('/api/qrcode/:code', async (req, res) => {
  const record = urlStore[req.params.code]
  if (!record) return res.status(404).json({ error: 'Not found' })
  try {
    const qrDataUrl = await QRCode.toDataURL(record.originalUrl, { width: 300, margin: 2 })
    res.json({ qrcode: qrDataUrl, targetUrl: record.originalUrl, shortUrl: record.shortUrl })
  } catch { res.status(500).json({ error: 'Failed to generate' }) }
})

app.put('/api/:code', (req, res) => {
  const record = urlStore[req.params.code]
  if (!record) return res.status(404).json({ error: 'Not found' })
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL required' })
  try { new URL(url) } catch { return res.status(400).json({ error: 'Invalid URL' }) }
  record.originalUrl = url
  record.updatedAt = new Date().toISOString()
  saveData(urlStore)
  res.json({ message: 'Updated', shortUrl: record.shortUrl, newOriginalUrl: url, qrcodeUrl: `/api/qrcode/${req.params.code}` })
})

app.put('/api/update-qrcode/:code', upload.single('qrcode'), (req, res) => {
  const code = req.params.code
  const record = urlStore[code]
  if (!record) return res.status(404).json({ error: 'Not found' })
  if (!req.file) return res.status(400).json({ error: '请上传新图片' })
  const oldPath = path.join(__dirname, '..', record.imagePath.replace(/^\//, ''))
  if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
  record.imagePath = `/uploads/${req.file.filename}`
  record.originalName = req.file.originalname
  record.updatedAt = new Date().toISOString()
  saveData(urlStore)
  res.json({
    message: '二维码已更新！短链地址不变',
    shortUrl: record.shortUrl,
    imageUrl: `${BASE_URL}${record.imagePath}`,
    viewUrl: `/${code}`,
    originalName: req.file.originalname
  })
})

app.delete('/api/:code', (req, res) => {
  const code = req.params.code
  const record = urlStore[code]
  if (!record) return res.status(404).json({ error: 'Not found' })
  if (record.type === 'qrcode_image' && record.imagePath) {
    const filePath = path.join(__dirname, '..', record.imagePath.replace(/^\//, ''))
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
  delete urlStore[code]
  saveData(urlStore)
  res.json({ message: '已删除' })
})

app.get('/:code', (req, res) => {
  const record = urlStore[req.params.code]
  if (!record) return res.status(404).send('<h1>404 - 短链不存在</h1>')
  record.clickCount++
  saveData(urlStore)
  if (record.type === 'qrcode_image') {
    res.send(generateViewerPage(record))
  } else {
    res.redirect(record.originalUrl)
  }
})

app.get('/api/info/:code', (req, res) => {
  const record = urlStore[req.params.code]
  if (!record) return res.status(404).json({ error: 'Not found' })
  res.json(record)
})

function generateViewerPage(record) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>查看</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#667eea,#764ba2);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}.card{background:white;border-radius:20px;padding:48px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:420px;width:90%}.qrcode-wrapper{background:#f8f9fa;border-radius:16px;padding:24px;margin-bottom:24px}.qrcode-wrapper img{max-width:280px;width:100%;border-radius:8px}</style></head>
<body><div class="card"><div class="qrcode-wrapper"><img src="${record.imagePath}" alt="QR Code"/></div></div></body></html>`
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`)
  console.log(`\nAPI:`)
  console.log(`  GET    /api/list             - 获取所有短链列表`)
  console.log(`  POST   /api/upload-qrcode     - 上传二维码 → 短链`)
  console.log(`  POST   /api/shorten           - 输入URL → 短链+二维码`)
  console.log(`  PUT    /api/:code             - 更换目标URL`)
  console.log(`  PUT    /api/update-qrcode/:code - 更换二维码图片`)
  console.log(`  DELETE /api/:code             - 删除短链`)
  console.log(`  GET    /:code                 - 访问短链`)
})