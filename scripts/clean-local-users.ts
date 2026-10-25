import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL is missing from .env.local')
}

if (!serviceRoleKey) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing from .env.local')
}

const parsedUrl = new URL(supabaseUrl)
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

if (parsedUrl.protocol !== 'http:' || !localHosts.has(parsedUrl.hostname)) {
  throw new Error(
    `Refusing to delete users from non-local Supabase URL: ${supabaseUrl}`
  )
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function getAllUsers() {
  const users = []

  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    })

    if (error) throw error

    users.push(...data.users)
    if (data.users.length < 1000) return users
  }
}

async function cleanLocalUsers() {
  console.log(`Connected to local Supabase at ${supabaseUrl}`)

  const users = await getAllUsers()

  if (users.length === 0) {
    console.log('No Auth users found. Nothing to delete.')
    return
  }

  console.log(`Found ${users.length} Auth user(s).`)
  const readline = createInterface({ input: stdin, output: stdout })

  let confirmation: string
  try {
    confirmation = await readline.question(
      `This also removes associated app data. Type "delete ${users.length} users" to continue: `
    )
  } finally {
    readline.close()
  }

  if (confirmation !== `delete ${users.length} users`) {
    console.log('Confirmation did not match. No users were deleted.')
    return
  }

  for (const user of users) {
    const { error } = await supabase.auth.admin.deleteUser(user.id)

    if (error) {
      throw new Error(
        `Failed to delete ${user.email ?? user.id}: ${error.message}`
      )
    }

    console.log(`Deleted ${user.email ?? user.id}`)
  }

  console.log(`Deleted all ${users.length} local Auth user(s).`)
}

cleanLocalUsers().catch((error: unknown) => {
  console.error('Failed to clean local Supabase users:', error)
  process.exitCode = 1
})
