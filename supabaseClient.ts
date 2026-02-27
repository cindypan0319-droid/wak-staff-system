import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://xcwnqumixknrrjuglqpl.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhjd25xdW1peGtucnJqdWdscXBsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5ODMxMzIsImV4cCI6MjA4NzU1OTEzMn0.CP0qGH-zGWAJVaAWVKumOpb7s3-4fl5yAThUTSd0Hus'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)