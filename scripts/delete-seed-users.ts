
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.production' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const DRY_RUN = false // Change to false after verifying the accounts

const TEST_EMAILS = [
  'alice.admin@mail.utoronto.ca',
  'bob.male@mail.utoronto.ca',
  'carol.female@mail.utoronto.ca',
  'dana.female2@mail.utoronto.ca',
  'sam.prefernot@mail.utoronto.ca',
]

async function deleteTestUsers() {
  const targets = new Set(TEST_EMAILS)
  const found = new Map<string, string>()

  // Find the accounts in Supabase Auth.
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    })

    if (error) throw error

    for (const user of data.users) {
      const email = user.email?.toLowerCase()

      if (email && targets.has(email)) {
        found.set(email, user.id)
      }
    }

    if (data.users.length < 1000) break
  }

  for (const email of TEST_EMAILS) {
    const userId = found.get(email)

    if (!userId) {
      console.log(`NOT FOUND: ${email}`)
      continue
    }

    if (DRY_RUN) {
      console.log(`WOULD DELETE: ${email} (${userId})`)
      continue
    }

    const { error } = await supabase.auth.admin.deleteUser(userId)

    if (error) {
      console.error(`FAILED: ${email}: ${error.message}`)
    } else {
      console.log(`DELETED: ${email}`)
    }
  }

  console.log(
    `\nFinished. Dry run: ${DRY_RUN}. ` +
    `Found ${found.size} of ${TEST_EMAILS.length} accounts.`
  )
}

deleteTestUsers().catch(console.error)
