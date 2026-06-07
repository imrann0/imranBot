// Kullanıcının belirtilen role sahip olup olmadığını kontrol eder
function hasRole(interaction, roleName) {
  return interaction.member?.roles.cache.some(r => r.name === roleName);
}

// Rol yoksa hata mesajı gönderir, true/false döner
async function requireRole(interaction, roleName) {
  if (!hasRole(interaction, roleName)) {
    await interaction.reply({
      content: `❌ Bu komutu kullanmak için **${roleName}** rolüne sahip olman gerekiyor.`,
      ephemeral: true,
    });
    return false;
  }
  return true;
}

module.exports = { hasRole, requireRole };
