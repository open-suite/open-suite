#!/usr/bin/env perl
use strict;
use warnings;

my $path = shift @ARGV or die "usage: $0 BUNDLE_JS\n";
@ARGV == 0 or die "usage: $0 BUNDLE_JS\n";

open my $input, '<', $path or die "open $path: $!\n";
local $/;
my $bundle = <$input>;
close $input or die "close $path: $!\n";

sub replace_once {
	my ($label, $before, $after) = @_;
	my $count = () = $bundle =~ /\Q$before\E/g;
	die "$label: expected one upstream fragment, found $count\n" if $count != 1;
	$bundle =~ s/\Q$before\E/$after/;
}

replace_once(
	'destroy before remove',
	q|app.events.off("updatepermission",this._onRefresh);(| . "\n" .
		q|_a=this._menubarCont)|,
	q|app.events.off("updatepermission",this._onRefresh);var $mainMenu=$("#main-menu");if(| . "\n" .
		q|$mainMenu.data("smartmenus"))$mainMenu.smartmenus("destroy");(_a=this._menubarCont)|,
);
replace_once(
	'return and destroy before rebuild',
	q|this._onDocLayerInit()}if(this._menubarCont)|,
	q|this._onDocLayerInit();return}var $mainMenu=$("#main-menu");if(| . "\n" .
		q|$mainMenu.data("smartmenus"))$mainMenu.smartmenus("destroy");if(this._menubarCont)|,
);
replace_once(
	'initialize replacement',
	q|}$(| . "\n" . q|"#main-menu").smartmenus({hideOnClick:true|,
	q|}$mainMenu.smartmenus({hideOnClick:true|,
);

open my $output, '>', $path or die "open $path: $!\n";
print {$output} $bundle or die "write $path: $!\n";
close $output or die "close $path: $!\n";
